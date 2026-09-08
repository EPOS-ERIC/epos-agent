import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface, type Interface } from "node:readline";

const ROOT = process.env.EPOS_AGENT_ROOT || `${process.env.HOME}/epos-agent`;
const API_BASE = process.env.EPOS_API_BASE || "https://www.ics-c.epos-eu.org/api/v1";
const PROV_DIR = join(ROOT, "logs", "provenance");
const FDSN_CMD = join(ROOT, "services", "mcp-fdsnws-event", ".venv", "bin", "mcp-fdsnws-event-server");
const WORKSPACE = resolve(ROOT, "workspace");
function isInsideWorkspace(p: string, cwd: string) {
  const target = resolve(cwd, p);
  return target === WORKSPACE || target.startsWith(WORKSPACE + sep);
}

class StdioMcpClient {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  async start() {
    if (this.proc && !this.proc.killed) return;
    this.proc = spawn(FDSN_CMD, [], { cwd: join(ROOT, "services", "mcp-fdsnws-event"), stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => { /* keep stderr off stdout; inspect logs/mcp-smoke.err for smoke tests */ });
    this.proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("mcp-fdsnws-event exited"));
      this.pending.clear();
      this.proc = undefined;
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } catch {}
    });
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "epos-agent", version: "0.1.0" } });
    this.notify("notifications/initialized", {});
  }
  request(method: string, params: any) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error(`mcp-fdsnws-event is not running at ${FDSN_CMD}`);
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }
  notify(method: string, params: any) {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async stop() { this.rl?.close(); if (this.proc && !this.proc.killed) this.proc.kill(); }
}
const mcp = new StdioMcpClient();
const execFileAsync = promisify(execFile);
function imageMime(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}
async function imageBlock(path: string) {
  const mimeType = imageMime(path);
  if (!mimeType) throw new Error(`Unsupported image type for inline display: ${path}`);
  const data = (await readFile(path)).toString("base64");
  return { type: "image" as const, data, mimeType };
}

function now() { return new Date().toISOString(); }
function compactText(s: unknown, n = 500) { return typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : s; }
async function logProvenance(record: Record<string, unknown>) {
  await mkdir(PROV_DIR, { recursive: true });
  const file = join(PROV_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${record.action || "epos"}.json`);
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}
function url(path: string, params?: Record<string, unknown>) {
  const u = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") u.searchParams.set(k, JSON.stringify(v));
    else u.searchParams.set(k, String(v));
  }
  return u;
}
async function fetchJson(u: URL, signal?: AbortSignal) {
  const res = await fetch(u, { signal, headers: { accept: "application/json,*/*" } });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${u}: ${text.slice(0, 1000)}`);
  return { data, status: res.status, contentType: res.headers.get("content-type") || "unknown", bytes: new TextEncoder().encode(text).length };
}
function summarizeResource(r: any) {
  return {
    id: r.id, metaId: r.metaId, uid: r.uid, title: r.title,
    description: compactText(r.description, 700),
    dataServiceProvider: r.dataServiceProvider?.dataProviderLegalName,
    serviceProvider: r.serviceProvider?.dataProviderLegalName,
    scienceDomain: r.scienceDomain,
    keywords: r.keywords?.slice?.(0, 12),
    availableFormats: r.availableFormats?.map?.((f: any) => ({ label: f.label, format: f.format, type: f.type, href: f.href })) || [],
    href: r.href, hrefExtended: r.hrefExtended,
  };
}
async function getDetails(id: string, extended: boolean, signal?: AbortSignal) {
  return fetchJson(url(`/resources/details/${encodeURIComponent(id)}`, { extended: extended || undefined }), signal);
}

const searchTool = defineTool({
  name: "epos_search_resources",
  label: "EPOS Search Resources",
  description: "Search the authoritative EPOS Resources Service catalogue. Returns a concise metadata-driven shortlist; use describe tools before execution.",
  parameters: Type.Object({
    q: Type.Optional(Type.String({ description: "Free text query, e.g. earthquake, GNSS, volcano" })),
    startDate: Type.Optional(Type.String({ description: "Optional temporal start filter" })),
    endDate: Type.Optional(Type.String({ description: "Optional temporal end filter" })),
    bbox: Type.Optional(Type.String({ description: "Optional bounding box as expected by EPOS gateway" })),
    keywords: Type.Optional(Type.String({ description: "Catalogue keyword/facet filter" })),
    sciencedomains: Type.Optional(Type.String({ description: "Science domain filter" })),
    servicetypes: Type.Optional(Type.String({ description: "Service type filter" })),
    organisations: Type.Optional(Type.String({ description: "Organisation/provider filter" })),
    limit: Type.Optional(Type.Number({ description: "Maximum resources to return (default 10, max 50)" })),
    includeFacets: Type.Optional(Type.Boolean({ description: "Whether to include facet/filter metadata" })),
  }),
  async execute(_id, params: any, signal) {
    const limit = Math.max(1, Math.min(Number(params.limit || 10), 50));
    const u = url("/resources/search", { ...params, limit: undefined, includeFacets: undefined, facets: !!params.includeFacets });
    const { data, status, contentType, bytes } = await fetchJson(u, signal);
    const distributions = data?.results?.distributions || [];
    const record = { action: "search", timestamp: now(), endpoint: u.toString(), parameters: params, status, contentType, bytes, resultCount: distributions.length };
    const provenanceFile = await logProvenance(record);
    const result = { provenance: { ...record, provenanceFile }, totalResults: distributions.length, resources: distributions.slice(0, limit).map(summarizeResource), filters: params.includeFacets ? data.filters : undefined };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
  },
});

const describeResourceTool = defineTool({
  name: "epos_describe_resource",
  label: "EPOS Describe Resource",
  description: "Load detailed authoritative metadata for one EPOS distribution/resource ID.",
  parameters: Type.Object({
    resourceId: Type.String({ description: "EPOS distribution/resource instance id" }),
    extended: Type.Optional(Type.Boolean({ description: "Request extended metadata payload (can be large)" })),
  }),
  async execute(_id, params: any, signal) {
    const u = url(`/resources/details/${encodeURIComponent(params.resourceId)}`, { extended: params.extended || undefined });
    const { data, status, contentType, bytes } = await fetchJson(u, signal);
    const record = { action: "describe-resource", timestamp: now(), resourceId: params.resourceId, endpoint: u.toString(), status, contentType, bytes };
    const provenanceFile = await logProvenance(record);
    const result = { provenance: { ...record, provenanceFile }, resource: data };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
  },
});

const describeServiceTool = defineTool({
  name: "epos_describe_service",
  label: "EPOS Describe Service",
  description: "Describe the executable service, endpoint, advertised parameters, linked entities, formats, providers, and documentation for an EPOS resource ID.",
  parameters: Type.Object({ resourceId: Type.String({ description: "EPOS distribution/resource instance id" }) }),
  async execute(_id, params: any, signal) {
    const detailsUrl = url(`/resources/details/${encodeURIComponent(params.resourceId)}`);
    const linkedUrl = url(`/resources/linkedentities/parameters/${encodeURIComponent(params.resourceId)}`);
    const [details, linked] = await Promise.allSettled([fetchJson(detailsUrl, signal), fetchJson(linkedUrl, signal)]);
    if (details.status === "rejected") throw details.reason;
    const d = details.value.data;
    const service = {
      resourceId: params.resourceId, metaId: d.metaId, uid: d.uid, title: d.title,
      serviceName: d.serviceName, serviceDescription: d.serviceDescription, serviceDocumentation: d.serviceDocumentation,
      endpointTemplate: d.endpoint, serviceEndpoint: d.serviceEndpoint, operationid: d.operationid,
      serviceProvider: d.serviceProvider, dataProvider: d.dataProvider,
      serviceParameters: d.serviceParameters || [], availableFormats: d.availableFormats || [],
      linkedParameters: linked.status === "fulfilled" ? linked.value.data : { error: String(linked.reason) },
    };
    const record = { action: "describe-service", timestamp: now(), resourceId: params.resourceId, endpoint: detailsUrl.toString(), linkedEndpoint: linkedUrl.toString(), contentType: details.value.contentType };
    const provenanceFile = await logProvenance(record);
    const result = { provenance: { ...record, provenanceFile }, service };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
  },
});

const executeTool = defineTool({
  name: "epos_execute_service",
  label: "EPOS Execute Service",
  description: "Execute a read-only EPOS external access service via /execute/{resourceId}. Validates provided serviceParameters against catalogue metadata when strictValidation is true.",
  parameters: Type.Object({
    resourceId: Type.String({ description: "EPOS distribution/resource instance id to execute" }),
    format: Type.Optional(Type.String({ description: "Requested output format from availableFormats" })),
    inputFormat: Type.Optional(Type.String({ description: "Plugin input format if using a converted format" })),
    pluginId: Type.Optional(Type.String({ description: "Plugin id if using converted output" })),
    useDefaults: Type.Optional(Type.Boolean({ description: "Let EPOS gateway use default values" })),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    bbox: Type.Optional(Type.String()),
    serviceParameters: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Advertised service parameter name/value map, encoded into EPOS params JSON" })),
    strictValidation: Type.Optional(Type.Boolean({ description: "Validate names, required params, enums and readOnly defaults before execution (default true)" })),
    maxBytes: Type.Optional(Type.Number({ description: "Maximum response bytes returned to model (default 50000)" })),
  }),
  async execute(_id, params: any, signal) {
    const strict = params.strictValidation !== false;
    const details = await getDetails(params.resourceId, false, signal);
    const meta = details.data;
    const serviceParams = meta.serviceParameters || [];
    const provided = params.serviceParameters || {};
    if (strict) {
      const allowed = new Map(serviceParams.map((p: any) => [p.name, p]));
      const unknown = Object.keys(provided).filter(k => !allowed.has(k));
      if (unknown.length) throw new Error(`Unknown EPOS serviceParameters for ${params.resourceId}: ${unknown.join(", ")}. Call epos_describe_service first.`);
      const missing = serviceParams.filter((p: any) => p.required && String(p.readOnlyValue) !== "true" && provided[p.name] === undefined && !params.useDefaults && p.defaultValue === undefined).map((p: any) => p.name);
      if (missing.length) throw new Error(`Missing required EPOS serviceParameters: ${missing.join(", ")}`);
      for (const [k, v] of Object.entries(provided)) {
        const spec: any = allowed.get(k);
        if (spec?.Enum && Array.isArray(spec.Enum)) {
          const values = Array.isArray(v) ? v : [v];
          const bad = values.filter(x => !spec.Enum.includes(String(x)));
          if (bad.length) throw new Error(`Invalid enum value for ${k}: ${bad.join(", ")}. Allowed: ${spec.Enum.join(", ")}`);
        }
      }
    }
    const q: any = { useDefaults: !!params.useDefaults || undefined, format: params.format, inputFormat: params.inputFormat, pluginId: params.pluginId, startDate: params.startDate, endDate: params.endDate, bbox: params.bbox };
    if (Object.keys(provided).length) q.params = JSON.stringify(provided);
    const u = url(`/execute/${encodeURIComponent(params.resourceId)}`, q);
    const res = await fetch(u, { signal, headers: { accept: params.format || "*/*" } });
    const ab = await res.arrayBuffer();
    const bytes = ab.byteLength;
    const maxBytes = Math.max(1000, Math.min(Number(params.maxBytes || 50000), 1000000));
    const contentType = res.headers.get("content-type") || "unknown";
    const raw = new TextDecoder().decode(ab.slice(0, maxBytes));
    const truncated = bytes > maxBytes;
    const record = { action: "execute-service", timestamp: now(), resourceId: params.resourceId, resourceMetaId: meta.metaId, serviceName: meta.serviceName, provider: meta.serviceProvider?.dataProviderLegalName, endpoint: u.toString(), serviceEndpoint: meta.serviceEndpoint, parameters: { ...q, params: provided }, status: res.status, contentType, bytes, truncated };
    const provenanceFile = await logProvenance(record);
    if (!res.ok) throw new Error(`EPOS execute failed: HTTP ${res.status} ${res.statusText} from ${u}\n${raw.slice(0, 2000)}\nProvenance: ${provenanceFile}`);
    const result = { provenance: { ...record, provenanceFile }, dataPreview: raw, truncated };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
  },
});

const runPythonTool = defineTool({
  name: "epos_run_python",
  label: "EPOS Run Python",
  description: "Run Python code or a Python script only inside ~/epos-agent/workspace. Use it to process EPOS data, generate plots/PNGs, and optionally return an image inline.",
  parameters: Type.Object({
    code: Type.Optional(Type.String({ description: "Python source to write to a temporary script in the EPOS workspace and run" })),
    scriptPath: Type.Optional(Type.String({ description: "Existing .py script path; must be inside ~/epos-agent/workspace" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Execution timeout in ms; default 60000, max 300000" })),
    outputImagePath: Type.Optional(Type.String({ description: "Optional PNG/JPEG/GIF/WebP path inside workspace to return inline after execution" })),
  }),
  async execute(_id, params: any, signal, _onUpdate, ctx) {
    await mkdir(WORKSPACE, { recursive: true });
    let script: string;
    if (params.code) {
      script = join(WORKSPACE, `.epos-run-${Date.now()}.py`);
      await writeFile(script, params.code);
    } else if (params.scriptPath) {
      if (!isInsideWorkspace(params.scriptPath, ctx.cwd)) throw new Error(`scriptPath must be inside ${WORKSPACE}`);
      script = resolve(ctx.cwd, params.scriptPath);
    } else {
      throw new Error("Provide either code or scriptPath");
    }
    const timeout = Math.max(1000, Math.min(Number(params.timeoutMs || 60000), 300000));
    const args = Array.isArray(params.args) ? params.args : [];
    const { stdout, stderr } = await execFileAsync("python3", [script, ...args], {
      cwd: WORKSPACE,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, MPLBACKEND: "Agg", EPOS_AGENT_ROOT: ROOT, EPOS_WORKSPACE: WORKSPACE },
      signal,
    });
    const record = { action: "run-python", timestamp: now(), workspace: WORKSPACE, script, args, timeoutMs: timeout, stdoutBytes: stdout.length, stderrBytes: stderr.length, outputImagePath: params.outputImagePath };
    const provenanceFile = await logProvenance(record);
    const text = JSON.stringify({ provenance: { ...record, provenanceFile }, stdout, stderr }, null, 2);
    const content: any[] = [{ type: "text", text }];
    if (params.outputImagePath) {
      if (!isInsideWorkspace(params.outputImagePath, ctx.cwd)) throw new Error(`outputImagePath must be inside ${WORKSPACE}`);
      content.push(await imageBlock(resolve(ctx.cwd, params.outputImagePath)));
    }
    return { content, details: { provenance: { ...record, provenanceFile }, stdout, stderr } };
  },
});

const showImageTool = defineTool({
  name: "epos_show_image",
  label: "EPOS Show Image",
  description: "Display an existing PNG/JPEG/GIF/WebP image from ~/epos-agent/workspace inline in the Pi TUI/chat.",
  parameters: Type.Object({ path: Type.String({ description: "Image path inside ~/epos-agent/workspace" }) }),
  async execute(_id, params: any, _signal, _onUpdate, ctx) {
    if (!isInsideWorkspace(params.path, ctx.cwd)) throw new Error(`Image path must be inside ${WORKSPACE}`);
    const abs = resolve(ctx.cwd, params.path);
    return { content: [{ type: "text", text: `Displaying image: ${abs}` }, await imageBlock(abs)], details: { path: abs, mimeType: imageMime(abs) } };
  },
});

const fdsnMcpTool = defineTool({
  name: "epos_fdsnws_event_call",
  label: "EPOS FDSNWS Event MCP Call",
  description: "Call the bundled local mcp-fdsnws-event stdio MCP server for earthquake-event queries. Copies event IDs exactly from search results. Tools include fdsn_query_earthquakes, fdsn_get_earthquake_by_id, fdsn_get_arrivals_by_id, fdsn_get_allmagnitudes_by_id, fdsn_get_allorigins_by_id, fdsn_get_focalmechanism_by_id.",
  parameters: Type.Object({
    toolName: Type.String({ description: "Exact mcp-fdsnws-event tool name" }),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments for the selected MCP tool" })),
  }),
  async execute(_id, params: any) {
    const allowed = new Set(["fdsn_query_earthquakes", "fdsn_get_earthquake_by_id", "fdsn_get_arrivals_by_id", "fdsn_get_allmagnitudes_by_id", "fdsn_get_allorigins_by_id", "fdsn_get_focalmechanism_by_id"]);
    if (!allowed.has(params.toolName)) throw new Error(`Unsupported mcp-fdsnws-event tool: ${params.toolName}`);
    await mcp.start();
    const result = await mcp.request("tools/call", { name: params.toolName, arguments: params.arguments || {} });
    const record = { action: "fdsnws-event-mcp", timestamp: now(), mcpServer: "mcp-fdsnws-event", command: FDSN_CMD, toolName: params.toolName, parameters: params.arguments || {} };
    const provenanceFile = await logProvenance(record);
    const payload = { provenance: { ...record, provenanceFile }, result };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
  },
});

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Do not keep the large logo as a persistent widget: it crowds the editor area.
    // The full ASCII-art logo is printed once by the launcher before Pi starts.
    ctx.ui.setTitle("EPOS Agent");
    ctx.ui.setWorkingIndicator({ frames: ["🌍", "🌎", "🌏"], intervalMs: 180 });
    ctx.ui.setStatus("epos", "EPOS Agent");
    try { await mcp.start(); ctx.ui.setStatus("epos-fdsn", "FDSN MCP ready"); }
    catch (e) { ctx.ui.setStatus("epos-fdsn", "FDSN MCP unavailable"); }
  });
  pi.on("session_shutdown", async () => { await mcp.stop(); });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const input: any = event.input || {};
    const targetPath = input.path;
    if (!targetPath || typeof targetPath !== "string" || !isInsideWorkspace(targetPath, ctx.cwd)) {
      return {
        block: true,
        reason: `EPOS Agent write guard: ${event.toolName} may write only inside ${WORKSPACE}. Requested path: ${targetPath || "(missing)"}`,
        terminate: true,
      };
    }
  });
  pi.registerCommand("epos", { description: "Show EPOS Agent banner and operational hints", handler: async (_args, ctx) => { ctx.ui.notify("EPOS Agent: use epos_search_resources → epos_describe_service → epos_execute_service. Writable workspace: ~/epos-agent/workspace", "info"); } });
  pi.registerTool(searchTool);
  pi.registerTool(describeResourceTool);
  pi.registerTool(describeServiceTool);
  pi.registerTool(executeTool);
  pi.registerTool(runPythonTool);
  pi.registerTool(showImageTool);
  pi.registerTool(fdsnMcpTool);
}
