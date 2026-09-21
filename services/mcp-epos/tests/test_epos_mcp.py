from __future__ import annotations
import asyncio, json, tempfile, time, unittest, urllib.parse
from pathlib import Path
import tools.epos_mcp_http as m
from tools.epos_results import normalized_candidates

class MCPUnitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.old_state,self.old_artifacts=m.STATE,m.ARTIFACTS; m.STATE=m.StateRegistry(60);m.ARTIFACTS=Path(self.temp.name)
        self.token=m.PRINCIPAL.set({"name":"alice","fingerprint":"a","session":"one","scopes":"search,execute,artifacts,metrics"})
    def tearDown(self): m.PRINCIPAL.reset(self.token);m.STATE,m.ARTIFACTS=self.old_state,self.old_artifacts;self.temp.cleanup()
    async def fake_get(self,url,timeout=60):
        if "details" in url: body=json.dumps({"availableFormats":[{"format":"application/json"}],"serviceParameters":[{"name":"level","type":"number","minValue":1,"maxValue":3},{"name":"mode","enumValue":["a","b"]},{"name":"code","valuePattern":"[A-Z]{2}"}]}).encode()
        else: body=json.dumps({"results":{"distributions":[{"id":"a","title":"Earthquake catalog","description":"x"*400,"status":"active","availableFormats":[{"format":"APPLICATION/JSON"}],"serviceParameters":[{}]},{"id":"b","title":"Other","dataServiceProvider":{"dataProviderLegalName":"INGV"}}]}}).encode()
        return {"ok":True,"body":body,"text":body.decode(),"ct":"application/json","bytes":len(body)}
    async def test_search_filter_owner_and_description_cap(self):
        old=m.http_get;m.http_get=self.fake_get
        try:
            search=await m.tool_search({"q":"earthquake"}); self.assertEqual(search["candidates"][0]["distribution_id"],"a");self.assertEqual(len(search["candidates"][0]["description"]),300)
            filtered=await m.tool_filter({"search_id":search["search_id"],"format":"application/json"});self.assertEqual(filtered["total_candidates"],1)
            other=m.PRINCIPAL.set({"name":"bob","fingerprint":"b","session":"one","scopes":"search"});self.assertIn("not owned",(await m.tool_search_page({"search_id":search["search_id"]}))["message"]);m.PRINCIPAL.reset(other)
        finally:m.http_get=old
    async def test_preflight_constraints_and_confirmation(self):
        old=m.http_get;m.http_get=self.fake_get
        try:
            bad=await m.tool_prepare({"distribution_id":"x","format":"bad","params":json.dumps({"level":4,"mode":"z","code":"bad"})});self.assertEqual(len(bad["reasons"]),4)
            good=await m.tool_prepare({"distribution_id":"x","format":"application/json","startDate":"2020-01-01","endDate":"2020-05-01","params":json.dumps({"level":2,"mode":"a","code":"AA"})});self.assertTrue(good["requires_confirmation"])
            self.assertIn("confirm",(await m.tool_execute({"plan_id":good["plan_id"]}))["message"])
        finally:m.http_get=old
    async def test_artifact_cleanup_and_principal_download_ownership(self):
        a=m.save("x",b"data","text/plain"); path=m.artifact_file(a["artifact_id"])[0]; expires,kind,value,owner=m.STATE.values[a["artifact_id"]];m.STATE.values[a["artifact_id"]]=(0,kind,value,owner);m.cleanup_artifacts();self.assertFalse(path.exists());self.assertFalse(path.with_suffix(path.suffix+".meta.json").exists())
    def test_completeness_requires_explicit_pagination_evidence(self):
        plain=m.completeness_fields({"ct":"application/json","text":'{"limit": 10}'})
        self.assertTrue(plain["transportComplete"]);self.assertFalse(plain["paginationDetected"]);self.assertEqual(plain["scientificCompleteness"],"not_verified")
        paged=m.completeness_fields({"ct":"application/json","text":'{"offset": 0, "limit": 10}',"pagination_headers":{"link":'<https://example.test/page=2>; rel="next"'}})
        self.assertTrue(paged["paginationDetected"]);self.assertEqual(paged["paginationEvidence"],["header:link=<https://example.test/page=2>; rel=\"next\"","body:offset","body:limit"])
        metadata=m.completeness_fields({"ct":"application/xml","text":"<xml/>"},metadata_only=True)
        self.assertEqual(metadata["scientificCompleteness"],"not_applicable_metadata")
    async def test_special_execution_routes_and_format_metadata(self):
        calls=[]
        metadata={
            "ogc":{"availableFormats":[{"format":"application/vnd.ogc.wms_xml","href":"https://gateway/api/v1/ogcexecute/ogc"}],"serviceParameters":[
                {"name":"service","required":True,"defaultValue":"WMS","readOnlyValue":"true"},{"name":"request","required":True,"defaultValue":"GetMap","readOnlyValue":"true"},{"name":"version","required":True,"defaultValue":"1.3.0","readOnlyValue":"true"},{"name":"MAP","required":True,"defaultValue":"/maps/a.map","readOnlyValue":"true"},{"name":"layers","required":True,"defaultValue":"layer","readOnlyValue":"true"},{"name":"width","required":True,"type":"integer"}]},
            "converted":{"availableFormats":[{"format":"application/epos.geo+json","href":"https://gateway/api/v1/execute/converted?format=application/epos.geo+json&inputFormat=application/json&pluginId=plugin-1","inputFormat":"application/json","pluginId":"plugin-1","type":"CONVERTED"}],"serviceParameters":[{"name":"before","required":False,"type":"dateTime","valuePattern":"YYYY-MM-DD"},{"name":"after","required":False,"type":"dateTime","valuePattern":"YYYY-MM-DD"}]},
            "geo":{"availableFormats":[{"format":"application/epos.geo+json","href":"https://gateway/api/v1/execute/geo?format=GeoJSON","originalFormat":"GeoJSON"}],"serviceParameters":[{"name":"start_time","required":False,"type":"dateTime"},{"name":"minlatitude","required":True,"type":"float"}]},
        }
        async def fake(url,timeout=60):
            if "/details/" in url: body=json.dumps(metadata[url.split("/details/",1)[1]]).encode();return {"ok":True,"body":body,"text":body.decode(),"ct":"application/json","bytes":len(body)}
            calls.append(url)
            if "/ogcexecute/" in url:return {"ok":True,"status":302,"location":"https://provider.example/capabilities","body":b"","text":"","ct":"text/html","bytes":0}
            if "provider.example" in url:body=b"<xml/>";return {"ok":True,"status":200,"location":"","body":body,"text":body.decode(),"ct":"application/xml","bytes":len(body)}
            if "/execute/converted" in url:return {"ok":True,"status":204,"location":"","body":b"","text":"","ct":"application/epos.geo+json","bytes":0}
            body=b"{}";return {"ok":True,"status":200,"location":"","body":body,"text":body.decode(),"ct":"application/json","bytes":len(body)}
        old,old_public=m.http_get,m.public_http_url;m.http_get=fake;m.public_http_url=lambda value:value
        try:
            ogc=await m.tool_prepare({"distribution_id":"ogc","format":"application/vnd.ogc.wms_xml","params":json.dumps({"request":"GetCapabilities"})})
            self.assertEqual(ogc["reasons"],[]);plan=m.STATE.get(ogc["plan_id"],"plan");self.assertEqual(plan["execution_path"],"ogcexecute");self.assertNotIn("layers",plan["params"])
            capabilities=await m.tool_execute({"plan_id":ogc["plan_id"]});parsed=urllib.parse.urlparse(calls[-2]);query=urllib.parse.parse_qs(parsed.query)
            self.assertFalse(capabilities["paginationDetected"]);self.assertEqual(capabilities["scientificCompleteness"],"not_applicable_metadata")
            self.assertEqual(calls[-1],"https://provider.example/capabilities");self.assertIn("/ogcexecute/ogc",urllib.parse.urlparse(calls[-2]).path);self.assertNotIn("params",query);self.assertEqual(query["request"],["GetCapabilities"]);self.assertEqual(query["MAP"],["/maps/a.map"])
            converted=await m.tool_prepare({"distribution_id":"converted","format":"application/epos.geo+json","params":json.dumps({"before":"1996-01-21T00:00:00Z","after":"1995-04-10T00:00:00Z"})})
            plan=m.STATE.get(converted["plan_id"],"plan");self.assertEqual((plan["format"],plan["inputFormat"],plan["pluginId"]),("application/epos.geo+json","application/json","plugin-1"))
            no_data=await m.tool_execute({"plan_id":converted["plan_id"]});self.assertTrue(no_data["no_data"]);self.assertNotIn("artifact_id",no_data);self.assertEqual(no_data["scientificCompleteness"],"no_data")
            geo=await m.tool_prepare({"distribution_id":"geo","format":"GeoJSON","params":json.dumps({"start_time":"","minlatitude":"63"})})
            self.assertIn("plan_id",geo);self.assertEqual(m.STATE.get(geo["plan_id"],"plan")["format"],"GeoJSON")
        finally:m.http_get,m.public_http_url=old,old_public
    def test_normalization_retains_full_server_candidate(self):
        candidate=normalized_candidates({"results":{"distributions":[{"id":"x","description":"z"*400}]}})[0];self.assertEqual(len(candidate["description"]),400)
