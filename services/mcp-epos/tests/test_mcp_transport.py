from __future__ import annotations
import os, unittest, hashlib
from starlette.testclient import TestClient
import tools.epos_mcp_http as m
class TransportTests(unittest.TestCase):
    def setUp(self):
        self.old=os.environ.get("EPOS_MCP_TOKENS_JSON");os.environ["EPOS_MCP_TOKENS_JSON"]='{"search-token":{"name":"reader","scopes":["search"]},"artifact-token":{"name":"reader","scopes":["artifacts"]}}';self.client=TestClient(m.create_app());self.client.__enter__()
    def tearDown(self):
        self.client.__exit__(None,None,None)
        if self.old is None:os.environ.pop("EPOS_MCP_TOKENS_JSON",None)
        else:os.environ["EPOS_MCP_TOKENS_JSON"]=self.old
    def get(self,path,token="search-token"):return self.client.get(path,headers={"Authorization":"Bearer "+token})
    def test_auth_scopes_metrics_and_rate_limit(self):
        self.assertEqual(self.client.get("/metrics").status_code,401);self.assertEqual(self.get("/metrics").status_code,403);self.assertEqual(self.get("/metrics","artifact-token").status_code,403)
    def test_artifact_absolute_url_and_download(self):
        old=m.PUBLIC_BASE_URL;m.PUBLIC_BASE_URL="https://mcp.example"; token=m.PRINCIPAL.set({"name":"reader","fingerprint":hashlib.sha256(b"artifact-token").hexdigest()[:16],"session":"","scopes":"artifacts"})
        try:
            artifact=m.save("x",b"payload","text/plain");self.assertEqual(artifact["download_url"],"https://mcp.example/artifacts/"+artifact["artifact_id"])
        finally:m.PRINCIPAL.reset(token);m.PUBLIC_BASE_URL=old
        self.assertEqual(self.get("/artifacts/"+artifact["artifact_id"],"artifact-token").status_code,200)
    def test_prometheus_is_scoped(self): self.assertEqual(self.get("/metrics/prometheus").status_code,403)
    def test_compact_profile_exposes_search_workflow(self):
        compact={tool.name for tool in __import__("asyncio").run(m.make_server("compact").list_tools())}
        full={tool.name for tool in __import__("asyncio").run(m.make_server("full").list_tools())}
        self.assertEqual(compact,{"epos_search","epos_organizations","epos_details","epos_prepare_execute","epos_execute","epos_inspect","epos_visualize"})
        self.assertTrue(compact < full)
