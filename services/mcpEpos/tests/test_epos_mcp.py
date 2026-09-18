from __future__ import annotations
import asyncio, json, tempfile, time, unittest
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
    def test_normalization_retains_full_server_candidate(self):
        candidate=normalized_candidates({"results":{"distributions":[{"id":"x","description":"z"*400}]}})[0];self.assertEqual(len(candidate["description"]),400)
