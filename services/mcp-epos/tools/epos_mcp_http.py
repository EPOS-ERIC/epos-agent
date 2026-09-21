#!/usr/bin/env python3
"""Authenticated EPOS Streamable HTTP MCP server (official mcp SDK transport)."""
from __future__ import annotations

import argparse
import contextvars
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import socket
import threading
import time
import urllib.parse
import uuid
from datetime import UTC, date, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

try:
    from .epos_results import declared_parameters, normalized_candidates, summarize_candidates, summarize_details
except ImportError:
    from epos_results import declared_parameters, normalized_candidates, summarize_candidates, summarize_details

EPOS_API_BASE = os.environ.get("EPOS_API_BASE", "https://www.ics-c.epos-eu.org/api/v1").rstrip("/")
ARTIFACTS = Path(os.environ.get("EPOS_ARTIFACTS", str(Path(__file__).resolve().parent.parent / "artifacts")))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
MAX_RESPONSE_BYTES = 50 * 1024 * 1024
MAX_REQUEST_BYTES = 1024 * 1024
STATE_TTL_SECONDS = int(os.environ.get("EPOS_STATE_TTL_SECONDS", "1800"))
MAX_ARTIFACTS = int(os.environ.get("EPOS_MAX_ARTIFACTS", "1000"))
MAX_TIME_RANGE_DAYS = int(os.environ.get("EPOS_MAX_TIME_RANGE_DAYS", "366"))
MAX_BBOX_AREA_DEGREES = float(os.environ.get("EPOS_MAX_BBOX_AREA_DEGREES", "1000"))
CONFIRM_TIME_RANGE_DAYS = float(os.environ.get("EPOS_CONFIRM_TIME_RANGE_DAYS", "90"))
CONFIRM_BBOX_AREA_DEGREES = float(os.environ.get("EPOS_CONFIRM_BBOX_AREA_DEGREES", "100"))
PUBLIC_BASE_URL = os.environ.get("EPOS_PUBLIC_BASE_URL", "").rstrip("/")
RATE_LIMIT = int(os.environ.get("EPOS_RATE_LIMIT_PER_MINUTE", "60"))
ALLOWED_ORIGINS = {"http://127.0.0.1", "http://localhost"}
PRINCIPAL: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar("principal", default=None)
REQUEST_ID: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")
AUDIT_LOGGER = logging.getLogger("epos_mcp.audit")

def configure_audit_logging() -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    path = os.environ.get("EPOS_AUDIT_LOG_PATH")
    if path:
        handlers.append(RotatingFileHandler(path, maxBytes=int(os.environ.get("EPOS_AUDIT_MAX_BYTES", "10485760")), backupCount=int(os.environ.get("EPOS_AUDIT_BACKUPS", "5")), encoding="utf-8"))
    for handler in handlers: handler.setFormatter(logging.Formatter("%(message)s"))
    AUDIT_LOGGER.handlers, AUDIT_LOGGER.propagate, AUDIT_LOGGER.level = handlers, False, logging.INFO

class Metrics:
    buckets = (10, 50, 100, 500, 1000, 5000)
    def __init__(self) -> None:
        self.lock = threading.Lock(); self.requests = 0; self.status_codes: dict[str, int] = {}; self.tool_calls: dict[str, int] = {}; self.tool_errors: dict[str, int] = {}; self.latency: dict[str, dict[str, Any]] = {}
    def request(self, status: int) -> None:
        with self.lock: self.requests += 1; self.status_codes[str(status)] = self.status_codes.get(str(status), 0) + 1
    def tool(self, name: str, error: bool, ms: float) -> None:
        with self.lock:
            self.tool_calls[name] = self.tool_calls.get(name, 0) + 1; self.tool_errors[name] = self.tool_errors.get(name, 0) + int(error)
            item = self.latency.setdefault(name, {"count": 0, "sum": 0., "min": None, "max": 0., "buckets": {str(x): 0 for x in self.buckets}})
            item["count"] += 1; item["sum"] += ms; item["min"] = ms if item["min"] is None else min(item["min"], ms); item["max"] = max(item["max"], ms)
            for bucket in self.buckets:
                if ms <= bucket: item["buckets"][str(bucket)] += 1
    def snapshot(self) -> dict[str, Any]:
        with self.lock: return {"requests": self.requests, "status_codes": dict(self.status_codes), "tool_calls": dict(self.tool_calls), "tool_errors": dict(self.tool_errors), "tool_latency_ms": json.loads(json.dumps(self.latency))}
    def prometheus(self) -> str:
        data = self.snapshot(); lines = ["# TYPE epos_mcp_requests_total counter", f"epos_mcp_requests_total {data['requests']}"]
        lines += [f'epos_mcp_http_responses_total{{status="{k}"}} {v}' for k,v in data["status_codes"].items()]
        for name, value in data["tool_latency_ms"].items():
            lines += [f'epos_mcp_tool_calls_total{{tool="{name}"}} {data["tool_calls"].get(name,0)}', f'epos_mcp_tool_latency_ms_sum{{tool="{name}"}} {value["sum"]}', f'epos_mcp_tool_latency_ms_count{{tool="{name}"}} {value["count"]}']
            lines += [f'epos_mcp_tool_latency_ms_bucket{{tool="{name}",le="{k}"}} {v}' for k,v in value["buckets"].items()]
        return "\n".join(lines) + "\n"
METRICS = Metrics()

def principal() -> dict[str, str]: return PRINCIPAL.get() or {"name": "local", "fingerprint": "local", "session": ""}
class StateRegistry:
    def __init__(self, ttl_seconds: int | None = None) -> None: self.ttl_seconds = STATE_TTL_SECONDS if ttl_seconds is None else ttl_seconds; self.lock = threading.Lock(); self.values: dict[str, tuple[float,str,dict[str,Any],dict[str,str]]] = {}
    def put(self, kind: str, value: dict[str, Any]) -> str:
        identifier = str(uuid.uuid4())
        with self.lock: self._purge_locked(); self.values[identifier] = (time.monotonic()+self.ttl_seconds, kind, value, dict(principal()))
        return identifier
    def get(self, identifier: Any, kind: str, session_required: bool = True) -> dict[str, Any] | None:
        if not isinstance(identifier, str): return None
        with self.lock:
            self._purge_locked(); item = self.values.get(identifier)
            if not item or item[1] != kind: return None
            owner, caller = item[3], principal()
            if owner["fingerprint"] != caller["fingerprint"] or (session_required and owner.get("session") and owner["session"] != caller.get("session")): return None
            return item[2]
    def remove(self, identifier: str) -> None:
        with self.lock: self.values.pop(identifier, None)
    def _purge_locked(self) -> None:
        for key, item in list(self.values.items()):
            if item[0] <= time.monotonic():
                if item[1] == "artifact": _delete_artifact(Path(item[2].get("path", "")))
                del self.values[key]
STATE = StateRegistry()
def _delete_artifact(path: Path) -> None:
    try:
        resolved = path.resolve(); resolved.relative_to(ARTIFACTS.resolve())
        resolved.unlink(missing_ok=True); resolved.with_suffix(resolved.suffix + ".meta.json").unlink(missing_ok=True)
    except (OSError, ValueError): pass
def cleanup_artifacts() -> None:
    with STATE.lock:
        STATE._purge_locked()
        artifacts = sorted(((k,v) for k,v in STATE.values.items() if v[1] == "artifact"), key=lambda x:x[1][0])
        for key, value in artifacts[:-MAX_ARTIFACTS] if MAX_ARTIFACTS >= 0 else artifacts:
            _delete_artifact(Path(value[2].get("path", ""))); del STATE.values[key]

HTTP_CLIENT: httpx.AsyncClient | None = None
async def http_get(url: str, timeout: int = 60) -> dict[str, Any]:
    global HTTP_CLIENT
    if HTTP_CLIENT is None: HTTP_CLIENT = httpx.AsyncClient(follow_redirects=False, headers={"User-Agent":"epos-mcp/1.0"}, timeout=httpx.Timeout(timeout))
    try:
        async with HTTP_CLIENT.stream("GET", url) as response:
            size = int(response.headers.get("content-length", "0"))
            if size > MAX_RESPONSE_BYTES: return {"ok":False,"status":response.status_code,"error":"Response exceeds the 50 MiB limit."}
            body = b""
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) > MAX_RESPONSE_BYTES: return {"ok":False,"status":response.status_code,"error":"Response exceeds the 50 MiB limit."}
            if response.is_error: return {"ok":False,"status":response.status_code,"error":body.decode(errors="replace")[:2000]}
            pagination_headers={key.lower():value for key,value in response.headers.items() if key.lower() in {"link","content-range","x-total-count","x-page","x-current-page","x-total-pages","x-next-page","x-per-page"}}
            return {"ok":True,"status":response.status_code,"location":response.headers.get("location", ""),"pagination_headers":pagination_headers,"ct":response.headers.get("content-type", "application/octet-stream").split(";",1)[0],"body":body,"text":body.decode(response.encoding or "utf-8",errors="replace"),"bytes":len(body)}
    except httpx.HTTPError as exc: return {"ok":False,"status":0,"error":str(exc)}

def save(prefix: str, data: bytes, content_type: str) -> dict[str, str]:
    cleanup_artifacts(); suffix = ".geojson" if "geo+json" in content_type else ".json" if "json" in content_type else ".xml" if "xml" in content_type else ".csv" if "csv" in content_type else ".bin"
    path = ARTIFACTS / f"{prefix}-{uuid.uuid4().hex}{suffix}"; path.write_bytes(data); path.with_suffix(path.suffix+".meta.json").write_text(json.dumps({"content_type":content_type}), encoding="utf-8")
    artifact_id = STATE.put("artifact", {"path":str(path.resolve()), "content_type":content_type}); cleanup_artifacts(); relative=f"/artifacts/{artifact_id}"
    artifact = {"artifact_id":artifact_id, "download_url":PUBLIC_BASE_URL+relative} if PUBLIC_BASE_URL else {"artifact_id":artifact_id,"artifact_url":relative}
    if os.environ.get("EPOS_MCP_LOCAL_PATHS") == "1": artifact["artifact_path"] = str(path.resolve())
    return artifact
def artifact_file(identifier: Any) -> tuple[Path,str] | None:
    item=STATE.get(identifier,"artifact",session_required=False)
    if not item:return None
    path=Path(item["path"]).resolve()
    try: path.relative_to(ARTIFACTS.resolve())
    except ValueError:return None
    return (path,item["content_type"]) if path.is_file() else None
def public_http_url(value: str) -> str | None:
    parsed=urllib.parse.urlparse(value)
    if parsed.scheme not in {"http","https"} or not parsed.hostname:return None
    try:
        if any(not ipaddress.ip_address(x[4][0]).is_global for x in socket.getaddrinfo(parsed.hostname,None)):return None
    except socket.gaierror:return None
    return value
def result(data: dict[str,Any]) -> dict[str,Any]:
    data.setdefault("message", "OK"); return data
def error(message: str, reasons: list[dict[str,str]] | None=None) -> dict[str,Any]: return {"message":message,"reasons":reasons or []}
def window(candidates:list[dict[str,Any]], limit:int, offset:int, query:str="") -> dict[str,Any]: return summarize_candidates(candidates,limit,offset,description_limit=300)
def rank(candidates:list[dict[str,Any]], query:str) -> list[dict[str,Any]]:
    terms=query.casefold().split()
    def key(pair:tuple[int,dict[str,Any]])->tuple[Any,...]:
        i,x=pair; title=str(x.get("title") or "").casefold(); provider=str(x.get("provider") or "").casefold(); desc=str(x.get("description") or "").casefold(); score=sum(8*t in title+4*t in provider+1*t in desc for t in terms); active=0 if str(x.get("status","")).casefold() in {"active","1","true"} else 1
        return (-score,active,title,str(x.get("distribution_id")),i)
    return [x for _,x in sorted(enumerate(candidates),key=key)]
async def tool_search(args:dict[str,Any]) -> dict[str,Any]:
    try: limit,offset=int(args.get("limit",12)),int(args.get("offset",0))
    except (TypeError,ValueError): return error("limit and offset must be integers.")
    if not 1<=limit<=50 or offset<0:return error("limit must be 1..50 and offset non-negative.")
    pairs=[(k,v) for k,v in args.items() if k in {"q","keywords","organisations","sciencedomains","servicetypes","startDate","endDate","bbox","facetstype","facets"} and v]
    response=await http_get(EPOS_API_BASE+"/resources/search"+("?"+urllib.parse.urlencode(pairs) if pairs else ""))
    if not response["ok"]:return error(f"Gateway error {response['status']}.")
    artifact=save("search",response["body"],response["ct"])
    try:candidates=rank(normalized_candidates(json.loads(response["text"])),str(args.get("q", "")))
    except json.JSONDecodeError:return result({"message":"Search response was not JSON.",**artifact})
    search_id=STATE.put("search",{"candidates":candidates,"query":str(args.get("q", ""))})
    return result({"search_id":search_id,**artifact,**window(candidates,limit,offset)})
async def tool_search_page(args:dict[str,Any])->dict[str,Any]:
    state=STATE.get(args.get("search_id"),"search")
    if not state:return error("search_id is invalid, expired, or not owned by this session.")
    try: offset,limit=int(args.get("offset",0)),int(args.get("limit",12))
    except (ValueError,TypeError):return error("offset and limit must be integers.")
    return result({"search_id":args["search_id"],**window(state["candidates"],limit,offset)}) if offset>=0 and 1<=limit<=50 else error("offset must be non-negative and limit 1..50.")
async def tool_select(args:dict[str,Any])->dict[str,Any]:
    state=STATE.get(args.get("search_id"),"search")
    try:index=int(args.get("index"))
    except (TypeError,ValueError):return error("index must be an integer.")
    if not state or index < 0 or index >= len(state["candidates"]):return error("search_id or index is invalid, expired, or not owned by this session.")
    return result({"search_id":args["search_id"],"index":index,"candidate":state["candidates"][index]})
async def tool_filter(args:dict[str,Any])->dict[str,Any]:
    state=STATE.get(args.get("search_id"),"search")
    if not state:return error("search_id is invalid, expired, or not owned by this session.")
    try:offset,limit=int(args.get("offset",0)),int(args.get("limit",12))
    except (ValueError,TypeError):return error("offset and limit must be integers.")
    text=str(args.get("text","")).casefold(); provider=str(args.get("provider","")).casefold(); fmt=str(args.get("format","")).casefold(); status=str(args.get("status","")).casefold(); executable=bool(args.get("executable_only",False))
    candidates=[x for x in state["candidates"] if (not text or text in " ".join(map(str,(x.get("title"),x.get("provider"),x.get("description")))).casefold()) and (not provider or provider in str(x.get("provider","")).casefold()) and (not fmt or fmt in " ".join(x.get("formats",[])).casefold()) and (not status or status==str(x.get("status","")).casefold()) and (not executable or bool(x.get("executable")))]
    return result({"search_id":args["search_id"],**window(candidates,limit,offset)})
async def tool_discover(args:dict[str,Any])->dict[str,Any]:
    query=str(args.get("query", "")); state=None
    for key,item in list(STATE.values.items()):
        if item[1]=="search" and item[2].get("query")==query and STATE.get(key,"search"): state=(key,item[2]); break
    if state is None:
        searched=await tool_search({"q":query,"limit":50});
        if "search_id" not in searched:return searched
        state=(searched["search_id"],STATE.get(searched["search_id"],"search"))
    provider=str(args.get("provider","")).casefold(); fmt=str(args.get("format","")).casefold(); executable=bool(args.get("executable_only",True)); candidates=[x for x in state[1]["candidates"] if (not provider or provider in str(x.get("provider","")).casefold()) and (not fmt or fmt in " ".join(x.get("formats",[])).casefold()) and (not executable or bool(x.get("executable")))]
    return result({"search_id":state[0],**window(rank(candidates,query),min(max(int(args.get("limit",12)),1),50),0)})
async def tool_details(args:dict[str,Any])->dict[str,Any]:
    identifier=str(args.get("distribution_id", "")); response=await http_get(f"{EPOS_API_BASE}/resources/details/{urllib.parse.quote(identifier,safe='')}")
    if not response["ok"]:return error(f"Gateway error {response['status']}.")
    artifact=save("details",response["body"],response["ct"])
    try:return result({**artifact,"details":summarize_details(json.loads(response["text"]))})
    except json.JSONDecodeError:return result({"message":"Details response was not JSON.",**artifact})
async def tool_organizations(args:dict[str,Any])->dict[str,Any]:
    pairs=[(key,value) for key,value in (("q",args.get("q","")),("country",args.get("country","")),("type",args.get("org_type",""))) if value]
    response=await http_get(EPOS_API_BASE+"/resources/organizations"+("?"+urllib.parse.urlencode(pairs) if pairs else ""))
    return result({"bytes":response["bytes"],**save("organizations",response["body"],response["ct"]),"preview":response["text"][:4000]}) if response["ok"] else error(f"Gateway error {response['status']}.")
def parse_date(value:Any)->datetime|None:
    if not isinstance(value,str) or not value.strip():return None
    try:return datetime.fromisoformat(value.replace("Z","+00:00")).replace(tzinfo=UTC) if datetime.fromisoformat(value.replace("Z","+00:00")).tzinfo is None else datetime.fromisoformat(value.replace("Z","+00:00"))
    except ValueError:
        try:return datetime.combine(date.fromisoformat(value),datetime.min.time(),UTC)
        except ValueError:return None
def bbox_area(value:Any)->float|None:
    try:w,s,e,n=map(float,value.split(",") if isinstance(value,str) else value); return (e-w)*(n-s) if -180<=w<=e<=180 and -90<=s<=n<=90 else None
    except (TypeError,ValueError):return None
def validate_value(name:str,value:Any,d:dict[str,Any])->str|None:
    if value in (None, "") and d.get("required") not in (True,"true",1):return None
    enum=d.get("enumValue"); values=enum if isinstance(enum,list) else str(enum).split(",") if enum else []
    if values and str(value) not in map(str,values):return f"{name} is not an allowed enum value"
    kind=str(d.get("type","")).casefold()
    if kind in {"number","numeric","integer","float","double"}:
        try:number=float(value)
        except (TypeError,ValueError):return f"{name} must be numeric"
        if "minValue" in d and number<float(d["minValue"]):return f"{name} is below minValue"
        if "maxValue" in d and number>float(d["maxValue"]):return f"{name} is above maxValue"
    if kind in {"boolean","bool"} and not isinstance(value,bool) and str(value).casefold() not in {"true","false","0","1"}:return f"{name} must be boolean"
    if "date" in kind:return None if parse_date(value) is not None else f"{name} must be an ISO date"
    pattern=d.get("valuePattern")
    if isinstance(pattern,str) and len(pattern)<200:
        try:
            if not re.fullmatch(pattern,str(value)):return f"{name} does not match valuePattern"
        except re.error:pass
    return None
def truthy(value:Any)->bool:return value in (True,1,"1") or (isinstance(value,str) and value.casefold()=="true")
def completeness_fields(response:dict[str,Any],metadata_only:bool=False)->dict[str,Any]:
    evidence=[];headers=response.get("pagination_headers") or {}
    for key,value in headers.items():
        if key!="link" or re.search(r'rel\s*=\s*["\']?(next|prev|first|last)',str(value),re.I):evidence.append(f"header:{key}={str(value)[:500]}")
    if "json" in str(response.get("ct", "")):
        try:data=json.loads(response.get("text", ""))
        except (TypeError,json.JSONDecodeError):data=None
        if isinstance(data,dict):
            pagination=data.get("pagination")
            if isinstance(pagination,dict):
                for key in ("next","nextPage","next_page","page","totalPages","total_pages","offset","limit"):
                    if key in pagination:evidence.append(f"body:pagination.{key}")
            else:
                for key in ("next","nextPage","next_page","totalPages","total_pages"):
                    if key in data:evidence.append(f"body:{key}")
                if "page" in data and ("totalPages" in data or "total_pages" in data):evidence.append("body:page")
                if "offset" in data and "limit" in data:evidence.extend(("body:offset","body:limit"))
    return {
        "transportComplete":True,
        "paginationDetected":bool(evidence),
        "paginationEvidence":evidence,
        "scientificCompleteness":"not_applicable_metadata" if metadata_only else "not_verified",
        "completenessReason":"The response is service metadata, not a scientific dataset." if metadata_only else "The full HTTP response was received, but provider-wide dataset coverage was not independently verified.",
    }
def execution_option(metadata:dict[str,Any], requested_format:str)->tuple[dict[str,Any]|None,list[str]]:
    options=summarize_details(metadata)["available_formats"]
    formats=[str(option.get("format")) for option in options if option.get("format")]
    requested=requested_format.casefold()
    for option in options:
        query=urllib.parse.parse_qs(urllib.parse.urlparse(str(option.get("href", ""))).query)
        aliases={str(option.get(key, "")).casefold() for key in ("format","label","originalFormat")}
        aliases.update(value.casefold() for value in query.get("format", []))
        if requested and requested in aliases:return option,formats
    if requested:return None,formats
    return (options[0],formats) if len(options)==1 else (None,formats)
async def tool_prepare(args:dict[str,Any])->dict[str,Any]:
    try: params=json.loads(args.get("params") or "{}")
    except json.JSONDecodeError:return error("params must be JSON.")
    if not isinstance(params,dict):return error("params must be a JSON object.")
    identifier=str(args.get("distribution_id", "")); response=await http_get(f"{EPOS_API_BASE}/resources/details/{urllib.parse.quote(identifier,safe='')}")
    if not response["ok"]:return error(f"Gateway error {response['status']}.")
    try:metadata=json.loads(response["text"])
    except json.JSONDecodeError:return error("Distribution details were not JSON.")
    known={x["name"]:x for x in declared_parameters(metadata)}; resolved=dict(params)
    option,formats=execution_option(metadata,str(args.get("format", "")))
    option_query=urllib.parse.parse_qs(urllib.parse.urlparse(str((option or {}).get("href", ""))).query)
    execution_path="ogcexecute" if "/ogcexecute/" in str((option or {}).get("href", "")) else "execute"
    request_name=str(resolved.get("request", "")).casefold()
    for key,d in known.items():
        if key not in resolved and truthy(d.get("readOnlyValue")) and "defaultValue" in d:
            if execution_path!="ogcexecute" or request_name!="getcapabilities" or key.casefold() in {"service","version","map"}:resolved[key]=d["defaultValue"]
    if str(args.get("useDefaults","")).lower()=="true":
        for key,d in known.items():
            if key not in resolved and "defaultValue" in d: resolved[key]=d["defaultValue"]
    reasons=[{"field":k,"reason":"unknown parameter"} for k in params if k not in known]
    if execution_path!="ogcexecute" or request_name!="getcapabilities":
        reasons += [{"field":k,"reason":"required parameter missing"} for k,d in known.items() if d.get("required") in (True,"true",1) and resolved.get(k) in (None,"")]
    reasons += [{"field":k,"reason":r} for k,v in resolved.items() if k in known and (r:=validate_value(k,v,known[k]))]
    fmt=str(args.get("format", ""))
    if fmt and option is None:reasons.append({"field":"format","reason":"format is not available"})
    if not fmt and option is None and len(formats)>1:reasons.append({"field":"format","reason":"select one available format"})
    start,end,bbox=args.get("startDate", ""),args.get("endDate", ""),args.get("bbox", ""); days=(parse_date(end)-parse_date(start)).total_seconds()/86400 if parse_date(start) and parse_date(end) else 0; area=bbox_area(bbox)
    if days<0 or days>MAX_TIME_RANGE_DAYS:reasons.append({"field":"date_range","reason":"invalid or exceeds maximum range"})
    if bbox and (area is None or area>MAX_BBOX_AREA_DEGREES):reasons.append({"field":"bbox","reason":"invalid or exceeds maximum area"})
    report={"reasons":reasons,"missing_required":[x["field"] for x in reasons if x["reason"]=="required parameter missing"],"unknown_params":[x["field"] for x in reasons if x["reason"]=="unknown parameter"],"resolved_params":{k:("[redacted]" if any(x in k.lower() for x in ("token","secret","password","apikey")) else v) for k,v in resolved.items()},"formats":formats}
    if reasons:return error("Execution plan was not created.",reasons)|report
    confirm=days>CONFIRM_TIME_RANGE_DAYS or (area is not None and area>CONFIRM_BBOX_AREA_DEGREES)
    converted=str((option or {}).get("type", "")).casefold()=="converted" or bool((option or {}).get("pluginId") or (option or {}).get("inputFormat"))
    planned_format=str((option or {}).get("format", "")) if converted else (option_query.get("format") or [fmt or (option or {}).get("format", "")])[0]
    input_format=str(args.get("inputFormat") or (option_query.get("inputFormat") or [(option or {}).get("inputFormat", "")])[0])
    plugin_id=str(args.get("pluginId") or (option_query.get("pluginId") or [(option or {}).get("pluginId", "")])[0])
    plan_data={"distribution_id":identifier,"execution_path":execution_path,"params":resolved,"format":planned_format,"inputFormat":input_format,"pluginId":plugin_id,"startDate":start,"endDate":end,"bbox":bbox,"useDefaults":"true" if str(args.get("useDefaults","")).lower()=="true" else "","requires_confirmation":confirm}
    plan=STATE.put("plan",plan_data)
    return result({"plan_id":plan,"requires_confirmation":confirm,"execution":{"endpoint":execution_path,"format":planned_format,"inputFormat":input_format,"pluginId":plugin_id},**report})
async def tool_execute(args:dict[str,Any])->dict[str,Any]:
    plan=STATE.get(args.get("plan_id"),"plan")
    if not plan:return error("plan_id is invalid, expired, or not owned by this session.")
    if plan["requires_confirmation"] and not bool(args.get("confirm",False)):return error("This plan requires confirm=true.")
    if plan["execution_path"]=="ogcexecute":pairs=list(plan["params"].items())
    else:pairs=[(k,v) for k,v in (("useDefaults",plan["useDefaults"]),("format",plan["format"]),("startDate",plan["startDate"]),("endDate",plan["endDate"]),("bbox",plan["bbox"]),("pluginId",plan["pluginId"]),("inputFormat",plan["inputFormat"]),("params",json.dumps(plan["params"],separators=(",",":")) if plan["params"] else "")) if v]
    url=f"{EPOS_API_BASE}/{plan['execution_path']}/{urllib.parse.quote(plan['distribution_id'],safe='')}"+("?"+urllib.parse.urlencode(pairs) if pairs else "")
    response=await http_get(url,120)
    if plan["execution_path"]=="ogcexecute" and 300<=int(response.get("status",0))<400 and response.get("location"):
        redirect=public_http_url(urllib.parse.urljoin(url,response["location"]))
        if not redirect:return error("EPOS OGC redirect did not resolve to a public HTTP/HTTPS URL.")
        response=await http_get(redirect,120)
    if not response["ok"]:return error(f"Gateway error {response['status']}: {response.get('error','unknown error')}")
    metadata_only=plan["execution_path"]=="ogcexecute" and str(plan["params"].get("request", "")).casefold()=="getcapabilities"
    completeness=completeness_fields(response,metadata_only)
    if response.get("status")==204:return result({"status":204,"no_data":True,"bytes":0,"content_type":response["ct"],**completeness,"scientificCompleteness":"no_data","completenessReason":"The provider returned HTTP 204 No Content.","message":"Execution completed but the provider returned no content."})
    artifact=save("execute",response["body"],response["ct"]); return result({"bytes":response["bytes"],"content_type":response["ct"],**artifact,**completeness,"preview":response["text"][:4000]})
async def tool_artifact(args:dict[str,Any], visual:bool=False)->dict[str,Any]:
    record=artifact_file(args.get("artifact_id"));
    if not record:return error("artifact_id is invalid, expired, or not owned by this principal.")
    path,ct=record; body=path.read_bytes()
    if visual:
        html=b"<html><body><pre>Artifact visualization is available for download.</pre></body></html>"; return result(save("visualization",html,"text/html"))
    return result({"artifact_id":args["artifact_id"],"bytes":len(body),"content_type":ct})
async def tool_fetch(args:dict[str,Any])->dict[str,Any]:
    url=public_http_url(str(args.get("url", "")))
    if not url:return error("Only public HTTP/HTTPS URLs are supported.")
    response=await http_get(url,120)
    return result({"bytes":response["bytes"],**save("fetched",response["body"],response["ct"])}) if response["ok"] else error(f"Gateway error {response['status']}.")

TOOL_SCOPES={"epos_search":"search","epos_search_page":"search","epos_select_candidate":"search","epos_search_filter":"search","epos_discover":"search","epos_organizations":"search","epos_details":"search","epos_prepare_execute":"execute","epos_execute":"execute","epos_inspect":"artifacts","epos_visualize":"artifacts","epos_fetch":"artifacts"}
DISPATCH={"epos_search":tool_search,"epos_search_page":tool_search_page,"epos_select_candidate":tool_select,"epos_search_filter":tool_filter,"epos_discover":tool_discover,"epos_organizations":tool_organizations,"epos_details":tool_details,"epos_prepare_execute":tool_prepare,"epos_execute":tool_execute,"epos_inspect":tool_artifact,"epos_visualize":lambda a:tool_artifact(a,True),"epos_fetch":tool_fetch}
async def invoke(name:str,args:dict[str,Any])->dict[str,Any]:
    start=time.perf_counter(); failed=False
    try:
        if TOOL_SCOPES[name] not in principal().get("scopes","").split(",") and "admin" not in principal().get("scopes","").split(","): return error("Forbidden: token lacks required scope.")
        return await DISPATCH[name](args)
    except Exception:
        failed=True; return error("Internal tool error.")
    finally:
        ms=(time.perf_counter()-start)*1000; METRICS.tool(name,failed,ms); AUDIT_LOGGER.info(json.dumps({"event":"tool_call","tool":name,"error":failed,"latency_ms":round(ms,3),"request_id":REQUEST_ID.get(),"principal":principal()["name"]}))
def make_server(tool_profile:str|None=None)->MCPServer:
    server=MCPServer("epos-mcp",version="1.1.0")
    profile=(tool_profile or os.environ.get("EPOS_MCP_TOOL_PROFILE","compact")).lower()
    if profile not in {"compact","full"}:raise RuntimeError("EPOS_MCP_TOOL_PROFILE must be compact or full.")
    def register(name:str, fn:Any, description:str)->None: server.tool(name=name,description=description,structured_output=True)(fn)
    async def search(q:str="",keywords:str="",organisations:str="",sciencedomains:str="",servicetypes:str="",startDate:str="",endDate:str="",bbox:str="",facetstype:str="",facets:str="",limit:int=12)->dict[str,Any]:return await invoke("epos_search",locals())
    async def compact_search(q:str="",startDate:str="",endDate:str="",bbox:str="",organisations:str="")->dict[str,Any]:return await invoke("epos_search",{"q":q,"startDate":startDate,"endDate":endDate,"bbox":bbox,"organisations":organisations,"limit":5})
    async def page(search_id:str,offset:int=0,limit:int=12)->dict[str,Any]:return await invoke("epos_search_page",locals())
    async def select(search_id:str,index:int)->dict[str,Any]:return await invoke("epos_select_candidate",locals())
    async def filter(search_id:str,text:str="",provider:str="",format:str="",status:str="",executable_only:bool=False,offset:int=0,limit:int=12)->dict[str,Any]:return await invoke("epos_search_filter",locals())
    async def discover(query:str,provider:str="",format:str="",executable_only:bool=True,limit:int=12)->dict[str,Any]:return await invoke("epos_discover",locals())
    async def details(distribution_id:str,extended:str="false")->dict[str,Any]:return await invoke("epos_details",locals())
    async def organizations(q:str="",country:str="",org_type:str="")->dict[str,Any]:return await invoke("epos_organizations",locals())
    async def prepare(distribution_id:str,params:str="",format:str="",startDate:str="",endDate:str="",bbox:str="",useDefaults:str="",pluginId:str="",inputFormat:str="")->dict[str,Any]:return await invoke("epos_prepare_execute",locals())
    async def execute(plan_id:str,confirm:bool=False)->dict[str,Any]:return await invoke("epos_execute",locals())
    async def inspect(artifact_id:str)->dict[str,Any]:return await invoke("epos_inspect",locals())
    async def visualize(artifact_id:str)->dict[str,Any]:return await invoke("epos_visualize",locals())
    async def fetch(url:str)->dict[str,Any]:return await invoke("epos_fetch",locals())
    tools=[("epos_search",compact_search,"Search EPOS distributions using q, dates, bbox, and organization IDs."),("epos_organizations",organizations,"Search organizations."),("epos_details",details,"Read distribution metadata."),("epos_prepare_execute",prepare,"Validate and prepare execution."),("epos_execute",execute,"Execute a validated plan."),("epos_inspect",inspect,"Inspect an artifact."),("epos_visualize",visualize,"Create an artifact visualization.")]
    if profile=="full":tools=[("epos_search",search,"Search EPOS distributions."),("epos_search_page",page,"Page a cached search."),("epos_select_candidate",select,"Select a cached candidate."),("epos_search_filter",filter,"Filter cached search candidates."),*tools[1:],("epos_fetch",fetch,"Fetch a public URL.")]
    for name,fn,desc in tools:register(name,fn,desc)
    return server
def tokens_from_env(fallback:str="")->dict[str,dict[str,Any]]:
    raw=os.environ.get("EPOS_MCP_TOKENS_JSON")
    if raw:
        try:
            parsed=json.loads(raw)
            if not isinstance(parsed,dict):raise ValueError
            return {str(k):{"name":str(v.get("name","token")),"scopes":set(v.get("scopes",[]))} for k,v in parsed.items() if isinstance(v,dict)}
        except (json.JSONDecodeError,ValueError):raise RuntimeError("EPOS_MCP_TOKENS_JSON must be an object mapping tokens to name/scopes.")
    return {fallback:{"name":"admin","scopes":{"search","execute","artifacts","metrics","admin"}}} if fallback else {}
class SecurityAuditMiddleware:
    def __init__(self,app:ASGIApp,tokens:dict[str,dict[str,Any]],origins:set[str])->None:self.app,self.tokens,self.origins,self.buckets=app,tokens,origins,{}
    async def __call__(self,scope:Scope,receive:Receive,send:Send)->None:
        if scope["type"]!="http":return await self.app(scope,receive,send)
        request=Request(scope); started=time.perf_counter(); status=500; request_id=str(uuid.uuid4()); origin=request.headers.get("origin","").rstrip("/")
        async def out(message:Message)->None:
            nonlocal status
            if message["type"]=="http.response.start":status=message["status"]
            await send(message)
        token=request.headers.get("authorization","")[7:] if request.headers.get("authorization","").startswith("Bearer ") else ""; info=self.tokens.get(token)
        try:
            if origin and origin not in self.origins:return await JSONResponse({"error":"Origin is not allowed"},403)(scope,receive,out)
            if scope["method"]=="OPTIONS":return await Response(status_code=204)(scope,receive,out)
            if self.tokens and not info:return await JSONResponse({"error":"Authentication required"},401,{"WWW-Authenticate":"Bearer"})(scope,receive,out)
            name=info["name"] if info else "local"; identity=hashlib.sha256(token.encode()).hexdigest()[:16] if token else "local"; key=(name,scope.get("client",("",))[0]); now=time.monotonic(); allowance,last=self.buckets.get(key,(float(RATE_LIMIT),now)); allowance=min(float(RATE_LIMIT),allowance+(now-last)*RATE_LIMIT/60)
            if RATE_LIMIT and allowance<1:return await JSONResponse({"error":"Rate limit exceeded"},429)(scope,receive,out)
            self.buckets[key]=(allowance-1,now); required="metrics" if scope["path"].startswith("/metrics") else "artifacts" if scope["path"].startswith("/artifacts") else None
            if required and info and required not in info["scopes"] and "admin" not in info["scopes"]:return await JSONResponse({"error":"Forbidden"},403)(scope,receive,out)
            ptoken=PRINCIPAL.set({"name":name,"fingerprint":identity,"session":request.headers.get("mcp-session-id","") ,"scopes":",".join(info["scopes"] if info else {"admin"})}); rtoken=REQUEST_ID.set(request_id)
            try: await self.app(scope,receive,out)
            finally: PRINCIPAL.reset(ptoken); REQUEST_ID.reset(rtoken)
        finally:
            METRICS.request(status); AUDIT_LOGGER.info(json.dumps({"event":"http_request","method":scope["method"],"status":status,"latency_ms":round((time.perf_counter()-started)*1000,3),"request_id":request_id,"principal":info["name"] if info else "anonymous"}))
def create_app(token:str="",origins:set[str]|None=None)->ASGIApp:
    app=make_server().streamable_http_app(streamable_http_path="/mcp",stateless_http=False,max_request_body_size=MAX_REQUEST_BYTES,transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))
    async def health(_:Request)->Response:return JSONResponse({"status":"ok","service":"epos-mcp"})
    async def metrics(_:Request)->Response:return JSONResponse(METRICS.snapshot())
    async def prometheus(_:Request)->Response:return PlainTextResponse(METRICS.prometheus(),media_type="text/plain; version=0.0.4")
    async def artifact(req:Request)->Response:
        record=artifact_file(req.path_params["artifact_id"])
        return FileResponse(record[0],media_type=record[1],filename=record[0].name,content_disposition_type="attachment") if record else JSONResponse({"error":"Artifact not found or expired"},404)
    app.add_route("/healthz",health,["GET"]);app.add_route("/metrics",metrics,["GET"]);app.add_route("/metrics/prometheus",prometheus,["GET"]);app.add_route("/artifacts/{artifact_id}",artifact,["GET"])
    app.add_middleware(SecurityAuditMiddleware,tokens=tokens_from_env(token),origins=origins or ALLOWED_ORIGINS); return app
def main()->None:
    parser=argparse.ArgumentParser();parser.add_argument("--host",default=os.environ.get("EPOS_MCP_HOST","127.0.0.1"));parser.add_argument("--port",type=int,default=8765);parser.add_argument("--auth-token",default=os.environ.get("EPOS_MCP_AUTH_TOKEN",""));args=parser.parse_args();configure_audit_logging();uvicorn.run(create_app(args.auth_token),host=args.host,port=args.port,access_log=False)
if __name__=="__main__":main()
