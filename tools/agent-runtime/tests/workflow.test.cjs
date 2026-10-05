const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

const repository = path.resolve(__dirname, '../../..');
const source = require('node:fs').readFileSync(path.join(repository, 'tools/agent-runtime/index.ts'), 'utf8');

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epos-runtime-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tools/visualization'), { recursive: true });
  await fs.cp(path.join(repository, 'tools/visualization/templates'), path.join(root, 'tools/visualization/templates'), { recursive: true });
  for (const name of ['workflow.py', 'sync_requirements.py', 'requirements-core.txt']) await fs.copyFile(path.join(repository, 'tools/visualization', name), path.join(root, 'tools/visualization', name));
  if (process.env.ANALYSIS_TEST_PYTHON) {
    await fs.mkdir(path.join(root, 'tools/visualization/.venv/bin'), { recursive: true });
    await fs.symlink(process.env.ANALYSIS_TEST_PYTHON, path.join(root, 'tools/visualization/.venv/bin/python'));
  }
  const Type = new Proxy({}, { get: (_, name) => (...args) => name === 'Object' ? { properties: args[0] } : { kind: name, arguments: args } });
  const sandbox = { exports: {}, process: { ...process, env: { ...process.env, EPOS_AGENT_ROOT: root } }, Buffer, console, setTimeout, clearTimeout,
    require: name => name === '@earendil-works/pi-ai' ? { Type, StringEnum: values => ({ values }) }
      : name === '@earendil-works/pi-coding-agent' ? { defineTool: tool => tool } : require(name) };
  vm.createContext(sandbox);
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(compiled + '\nexports.testing = {eposMcp, mcp, preparedPlans, state: () => runtimeConversationState, requireDownloads, analysisFingerprint, writeStudyDocuments, nextConversationState};', sandbox);
  const tools = new Map(), events = new Map();
  sandbox.exports.default({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler), registerCommand() {}, appendEntry() {} });
  const calls = [];
  const api = sandbox.exports.testing;
  api.eposMcp.start = api.mcp.start = async () => {};
  api.eposMcp.request = async (_method, call) => {
    calls.push(call);
    const args = call.arguments;
    if (call.name === 'epos_prepare_execute') return { structuredContent: { plan_id: 'plan-' + args.distribution_id, resolved_plan: { distribution_id: args.distribution_id, params: JSON.parse(args.params || '{}'), format: args.format || 'csv' } } };
    if (call.name === 'epos_execute' || call.name === 'epos_fetch') {
      if (args.plan_id === 'plan-failed') return { structuredContent: { error: 'Gateway error 503' } };
      const artifact = path.join(root, 'services/mcp-epos/artifacts/events.csv');
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, 'time,latitude,longitude,magnitude\n2026-01-01T00:00:00Z,42,13,3\n2026-01-02T00:00:00Z,42.1,13.1,4\n');
      return { structuredContent: { artifact_path: artifact, scientificCompleteness: 'not_verified' } };
    }
    if (call.name === 'epos_search') return { structuredContent: { search_id: 'search-1', candidates: [{ distribution_id: 'a', title: 'A' }], next_offset: 1 } };
    if (call.name === 'epos_search_page') return { structuredContent: { candidates: [{ distribution_id: 'b', title: 'B' }], next_offset: null } };
    return { structuredContent: {} };
  };
  api.mcp.request = async (_method, call) => { calls.push(call); return { structuredContent: { columns: ['eventid', 'time', 'latitude', 'longitude', 'magnitude'], rows: [['1', '2026-01-01', 42, 13, 3]] } }; };
  let approvals = 0;
  const approvalPrompts = [];
  const ctx = { hasUI: true, ui: { confirm: async (...prompt) => { approvals++; approvalPrompts.push(prompt); return true; }, notify() {} }, sessionManager: { getSessionId: () => 'test-session' } };
  async function call(name, args = {}, context = ctx) {
    const result = await tools.get(name).execute('call', args, undefined, undefined, context);
    await events.get('tool_result')({ toolName: name, input: args, ...result });
    return result.details || JSON.parse(result.content[0].text);
  }
  async function prepare(ids = ['events']) {
    await call('epos_manage_study', { action: 'start', title: 'Fixture study' });
    const services = [];
    for (const id of ids) {
      await call('epos_prepare_execute', { distribution_id: id, params: '{"start":"2026-01-01"}', format: 'csv' });
      services.push({ resourceId: id, title: id, role: 'events', request: { tool: 'epos_execute', arguments: { plan_id: 'plan-' + id } } });
    }
    await call('epos_manage_study', { action: 'prepare', services });
  }
  return { root, api, tools, events, call, calls, ctx, prepare, approvals: () => approvals, approvalPrompts };
}

test('discovery traverses every cached page without model calls', async t => {
  const h = await harness(t);
  const result = await h.call('epos_search', { q: 'events' });
  assert.equal(result.total, 2);
  assert.equal(result.discoveryComplete, true);
  assert.deepEqual(h.calls.map(call => call.name), ['epos_search', 'epos_search_page']);
  assert.equal(JSON.parse(await fs.readFile(result.cataloguePath)).candidates.length, 2);
  await h.call('epos_search', { q: 'events' });
  assert.equal(h.calls.length, 2, 'repeated discovery must reuse the metadata cache');
});

test('wrapper contracts and acquisition through the real MCP stdio server', { skip: !process.env.MCP_TEST_PYTHON }, async t => {
  const h = await harness(t);
  const client = h.api.eposMcp;
  client.command = process.env.MCP_TEST_PYTHON;
  client.cwd = h.root;
  client.args = [path.join(__dirname, 'mcp_fixture.py')];
  client.env = { EPOS_MCP_LOCAL_PATHS: '1', EPOS_ARTIFACTS: path.join(h.root, 'services/mcp-epos/artifacts') };
  client.start = Object.getPrototypeOf(client).start.bind(client);
  client.request = Object.getPrototypeOf(client).request.bind(client);
  t.after(() => client.stop());
  await client.start();
  const listed = await client.request('tools/list', {});
  for (const name of ['epos_search_filter', 'epos_prepare_execute', 'epos_inspect', 'epos_visualize', 'epos_fetch']) {
    const remote = listed.tools.find(tool => tool.name === name).inputSchema;
    const wrapper = h.tools.get(name).parameters.properties;
    for (const field of Object.keys(wrapper)) assert.ok(field in remote.properties, `${name}.${field} must exist in the server contract`);
    for (const field of remote.required || []) assert.ok(field in wrapper, `${name}.${field} is required by the server`);
  }
  const search = await h.call('epos_search', { q: 'catalogue' });
  assert.equal(search.total, 70);
  assert.equal(search.candidates.length, 30);
  await h.call('epos_manage_study', { action: 'start', title: 'Real transport' });
  const prepared = await h.call('epos_prepare_execute', { distribution_id: '0', format: 'text/csv', params: '{"minimum":3}' });
  await h.call('epos_manage_study', { action: 'prepare', services: [{ resourceId: '0', title: 'Events', role: 'events', request: { tool: 'epos_execute', arguments: { plan_id: prepared.plan_id } } }] });
  await h.call('epos_manage_study', { action: 'download' });
  const result = h.api.state().study.downloads[0];
  assert.equal(result.outcome, 'downloaded', result.error);
  assert.equal(result.resolvedPlan.params.minimum, 3);
  assert.match(await fs.readFile(result.outputFile, 'utf8'), /latitude,longitude/);
  await assert.rejects(h.call('epos_prepare_execute', { distribution_id: '0', format: 'invalid' }), /not created/);
});

test('no study, arbitrary fetch flags and FDSN details cannot bypass approval', async t => {
  const h = await harness(t);
  await assert.rejects(h.call('epos_execute', { plan_id: 'x' }), /approval/);
  await assert.rejects(h.call('epos_fetch', { url: 'https://example.org/data', metadataOnly: true }), /approval/);
  await assert.rejects(h.call('epos_fdsnws_event_call', { toolName: 'fdsn_get_earthquake_by_id', arguments: { eventid: '1' } }), /approval/);
  assert.equal(h.calls.length, 0);
});

test('declining the UI plan or running without UI starts no downloads', async t => {
  const h = await harness(t);
  await h.prepare();
  const before = h.calls.length;
  h.ctx.ui.confirm = async () => false;
  assert.equal((await h.call('epos_manage_study', { action: 'download' })).approved, false);
  await assert.rejects(h.call('epos_manage_study', { action: 'download' }, { ...h.ctx, hasUI: false }), /interface/);
  assert.equal(h.calls.length, before);
});

test('one approval executes the batch, records failure, and avoids duplicate transfers', async t => {
  const h = await harness(t);
  await h.prepare(['events', 'failed']);
  const result = await h.call('epos_manage_study', { action: 'download' });
  assert.deepEqual(Array.from(result.downloadSummary, item => item.outcome), ['downloaded', 'unavailable']);
  assert.equal(h.approvals(), 1);
  assert.deepEqual(h.approvalPrompts[0], ['Conferma download', 'Sono pronto a scaricare i dati. Confermi di procedere?']);
  assert.doesNotMatch(h.approvalPrompts[0].join(' '), /plan_id|\{|\}/);
  const before = h.calls.length;
  await h.call('epos_manage_study', { action: 'download' });
  assert.equal(h.calls.length, before);
  assert.equal(h.approvals(), 1);
  const bundle = h.api.state().study.bundlePath;
  const records = JSON.parse(await fs.readFile(path.join(bundle, 'metadata/provenance.json'))).records;
  assert.ok(records.some(item => item.action === 'approval' && item.approved));
  assert.ok(records.some(item => item.outcome === 'unavailable'));
  assert.ok(h.api.state().study.downloadedBytes > 0);
  h.api.state().study.services[0].request.arguments.plan_id = 'another-plan';
  await assert.rejects(h.call('epos_execute', { plan_id: 'another-plan' }), /approval/);
});

test('a different request cannot reuse an existing approval; stale reports cannot finalize', async t => {
  const h = await harness(t);
  await h.prepare();
  await h.call('epos_manage_study', { action: 'download' });
  await assert.rejects(h.call('epos_execute', { plan_id: 'other' }), /not in the approved/);
  const report = path.join(h.api.state().study.bundlePath, 'metadata/analysis-report.json');
  await fs.writeFile(report, '{"outputs":["old.png"]}');
  await assert.rejects(h.call('epos_finalize_notebook'), /current code/);
  await assert.rejects(h.call('epos_manage_study', { action: 'complete' }), /current analysis/);
});

test('FDSN detail calls require approval and persist even small responses', async t => {
  const h = await harness(t);
  await h.call('epos_manage_study', { action: 'start', title: 'Details' });
  await h.call('epos_manage_study', { action: 'prepare', services: [{ resourceId: 'INGV', title: 'Event', role: 'events', request: { tool: 'epos_fdsnws_event_call', arguments: { toolName: 'fdsn_get_earthquake_by_id', arguments: { eventid: '1', datacenter: 'INGV' } } } }] });
  await h.call('epos_manage_study', { action: 'download' });
  const download = h.api.state().study.downloads[0];
  assert.equal(download.outcome, 'downloaded');
  assert.ok(download.bytes > 0);
  await fs.access(download.outputFile);
});

test('retry requires fresh approval and preserves unsuccessful attempts', async t => {
  const h = await harness(t);
  await h.prepare(['failed']);
  await h.call('epos_manage_study', { action: 'download' });
  const before = h.calls.length;
  await h.call('epos_manage_study', { action: 'download', retryFailed: true });
  assert.equal(h.approvals(), 2);
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.api.state().study.downloads.length, 2);
  assert.throws(() => h.api.requireDownloads(), /No usable/);
});

test('changed plan during approval is rejected before any transfer', async t => {
  const h = await harness(t);
  await h.prepare();
  h.ctx.ui.confirm = async () => { h.api.state().study.services[0].title = 'changed'; return true; };
  await assert.rejects(h.call('epos_manage_study', { action: 'download' }), /plan changed/);
  assert.equal(h.calls.filter(call => call.name === 'epos_execute').length, 0);
});

test('partial and no-data results remain distinct and cannot complete a study', async t => {
  const h = await harness(t);
  await h.prepare(['events']);
  const original = h.api.eposMcp.request;
  h.api.eposMcp.request = async (...args) => {
    const result = await original(...args);
    if (args[1].name === 'epos_execute') result.structuredContent.paginationDetected = true;
    return result;
  };
  await h.call('epos_manage_study', { action: 'download' });
  assert.equal(h.api.state().study.downloads[0].outcome, 'partial');
  assert.match(h.api.state().study.downloads[0].outputFile, /\.partial\.csv$/);
  assert.throws(() => h.api.requireDownloads(), /No usable/);
  await h.prepare();
  h.api.eposMcp.request = async (_method, call) => call.name === 'epos_execute' ? { structuredContent: { no_data: true, bytes: 0 } } : original(_method, call);
  await h.call('epos_manage_study', { action: 'download' });
  assert.equal(h.api.state().study.downloads[0].outcome, 'no_data');
});

test('real local analysis creates and executes a notebook without changing acquisition history', { skip: !process.env.ANALYSIS_TEST_PYTHON }, async t => {
  const h = await harness(t);
  await h.prepare();
  await h.call('epos_manage_study', { action: 'download' });
  const study = h.api.state().study;
  const suggestions = await h.call('epos_suggest_visualizations');
  assert.ok(suggestions.suggestions.some(item => item.kind === 'map'));
  await h.call('epos_prepare_visualization', { recipe: { name: 'custom' }, basemap: 'none', datasets: [{ path: path.relative(study.bundlePath, study.downloads[0].outputFile), role: 'events', plots: ['distribution'] }] });
  const result = await h.call('epos_run_python', { scriptPath: 'code/analysis.py', timeoutMs: 120000 });
  assert.ok(result.outputs.length > 0);
  const notebook = JSON.parse(await fs.readFile(result.notebookPath));
  assert.ok(notebook.cells.filter(cell => cell.cell_type === 'code').every(cell => cell.execution_count > 0));
  assert.match(notebook.cells.find(cell => cell.id === 'display-outputs').source.join(''), /IFrame\(src=link/);
  assert.ok(h.api.state().study.notebookDigest);
  const inventory = JSON.parse(await fs.readFile(path.join(study.bundlePath, 'metadata/inventory.json')));
  assert.ok(inventory.files.some(item => item.path.endsWith('.ipynb') && item.sha256.length === 64));
  assert.ok(inventory.files.some(item => item.path.startsWith('data/')));
  const records = JSON.parse(await fs.readFile(path.join(study.bundlePath, 'metadata/provenance.json'))).records;
  assert.ok(records.some(item => item.action === 'acquisition'));
  await fs.appendFile(path.join(study.bundlePath, 'code/analysis.py'), '\n# changed\n');
  await assert.rejects(h.call('epos_finalize_notebook'), /current code/);
  await h.call('epos_prepare_visualization', { recipe: { name: 'custom' }, basemap: 'none' });
  await fs.writeFile(path.join(study.bundlePath, 'code/analysis.py'), 'raise RuntimeError("fixture analysis failure")\n');
  await assert.rejects(h.call('epos_run_python', { scriptPath: 'code/analysis.py' }), error => {
    assert.match(error.message, /fixture analysis failure/);
    assert.ok(error.message.length < 800, 'full Python tracebacks must not reach model context');
    return true;
  });
  assert.equal(h.api.state().study.notebookDigest, undefined);
});
