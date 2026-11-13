'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const updater = require('../update.cjs');
const required = ['install.sh', 'install.ps1', 'bin/epos-agent', 'bin/epos-agent.ps1', 'tools/updater/update.cjs'];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epos-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'installed agent');
  const stage = path.join(directory, 'new release');
  fs.mkdirSync(root); fs.mkdirSync(stage);
  function populate(target, version, extras = {}) {
    const contents = { VERSION: version + '\n', ...Object.fromEntries(required.map(name => [name, `${name} ${version}\n`])), ...extras };
    const manifest = { version, files: Object.entries(contents).map(([name, value]) => {
      const file = path.join(target, name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
      return { path: name, sha256: updater.hash(Buffer.from(value)), mode: 0o644 };
    }) };
    return manifest;
  }
  const old = populate(root, '1.0.3', { 'obsolete.txt': 'old' });
  fs.writeFileSync(path.join(root, '.epos-update.json'), JSON.stringify(old));
  const next = populate(stage, '1.0.4', { 'new.txt': 'new' });
  const data = {
    'config/profile.env': 'API_KEY=secret', 'config/pi-agent/auth.json': 'credentials',
    'workspace/study/data.csv': 'scientific data', 'sessions/session.json': 'session',
    'logs/provenance/download.json': 'provenance', 'cache/query.json': 'cache',
    'services/mcp-epos/artifacts/data.csv': 'artifact'
  };
  for (const [name, value] of Object.entries(data)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  }
  return { directory, root, stage, old, next, data, populate };
}

function preserved(root, data) {
  for (const [name, value] of Object.entries(data)) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), value);
}

test('stable versions compare numerically and reject invalid versions', () => {
  assert.equal(updater.compare('1.10.0', '1.9.9'), 1);
  assert.equal(updater.compare('1.0.3', '1.0.3'), 0);
  for (const value of ['1.0', '1.0.4-beta', '01.0.0', 'garbage']) assert.throws(() => updater.compare(value, '1.0.3'));
});

test('package paths reject traversal, runtime data and Windows ambiguities', () => {
  for (const name of ['../outside', '/absolute', 'a/../../x', 'a\\b', 'C:/x', '.git/config', '.GIT/config',
    '.runtime/bin', 'a/.venv/bin/python', 'config/pi-agent/auth.json', 'workspace/data',
    'logs/data', 'services/mcp-epos/artifacts/data', '.epos-update.json', 'a/NUL.txt', 'a./x', 'a:stream']) {
    assert.throws(() => updater.safeFile(name), name);
  }
  assert.equal(updater.safeFile('tools/updater/update.cjs'), 'tools/updater/update.cjs');
});

test('updates managed files, removes obsolete code and preserves user data', t => {
  const { root, stage, next, data } = fixture(t);
  let installed = false;
  updater.applyRelease(root, stage, next, () => { installed = true; });
  assert.equal(installed, true);
  updater.verify(root, next);
  assert.equal(fs.existsSync(path.join(root, 'obsolete.txt')), false);
  assert.equal(fs.existsSync(path.join(root, '.epos-update-lock')), false);
  assert.equal(fs.existsSync(path.join(root, '.epos-update-recovery.json')), false);
  preserved(root, data);
});

test('dependency failure restores code, state and all environments at original paths', t => {
  const { root, stage, old, next, data } = fixture(t);
  const environments = ['.runtime', 'services/mcp-epos/.venv', 'services/mcp-fdsnws-event/.venv', 'tools/visualization/.venv'];
  for (const name of environments) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'old'), 'working');
  }
  assert.throws(() => updater.applyRelease(root, stage, next, () => {
    for (const name of environments) {
      fs.rmSync(path.join(root, name), { recursive: true });
      fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'broken'), 'broken');
    }
    throw new Error('simulated pip failure');
  }), /simulated pip failure/);
  updater.verify(root, old);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  for (const name of environments) assert.equal(fs.readFileSync(path.join(root, name, 'old'), 'utf8'), 'working');
  preserved(root, data);
});

test('modified code and colliding untracked files prevent any installation', t => {
  const { root, stage, next } = fixture(t);
  fs.writeFileSync(path.join(root, 'install.sh'), 'local changes');
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail('must not install')), /modified/);
  assert.equal(fs.readFileSync(path.join(root, 'install.sh'), 'utf8'), 'local changes');
});

test('new release files cannot overwrite an existing user file', t => {
  const { root, stage, next, old } = fixture(t);
  fs.writeFileSync(path.join(root, 'new.txt'), 'user content');
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /overwritten/);
  updater.verify(root, old);
});

test('corrupt staging fails before changing installed code', t => {
  const { root, stage, next, old } = fixture(t);
  fs.writeFileSync(path.join(stage, 'VERSION'), '9.9.9');
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /modified/);
  updater.verify(root, old);
});

test('active sessions and concurrent updates block updating', t => {
  const { root, stage, next } = fixture(t);
  updater.session(root, String(process.pid));
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /sessions/);
  updater.session(root, String(process.pid), true);
  fs.mkdirSync(path.join(root, '.epos-update-lock'));
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /Another update/);
  assert.throws(() => updater.session(root, String(process.pid)), /Another update/);
});

test('symlinks cannot redirect managed writes outside installation', { skip: process.platform === 'win32' }, t => {
  const { root, stage, next, directory } = fixture(t);
  const external = path.join(directory, 'external');
  fs.mkdirSync(external);
  fs.rmSync(path.join(root, 'bin'), { recursive: true });
  fs.symlinkSync(external, path.join(root, 'bin'));
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /Symlink/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('downgrades are rejected', t => {
  const { root, stage, old, populate } = fixture(t);
  const next = populate(stage, '1.0.2');
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /newer/);
  updater.verify(root, old);
});

test('startup skips network in non-interactive mode', t => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../update.cjs'), 'startup', root], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('release ZIP initializes without Git and can be copied into an empty custom directory', t => {
  const { root, old, directory } = fixture(t);
  fs.rmSync(path.join(root, '.epos-update.json'));
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(old));
  updater.init(root);
  const destination = path.join(directory, 'custom install');
  updater.copySource(root, destination);
  updater.init(destination);
  updater.verify(destination, old);
  assert.throws(() => updater.copySource(root, destination), /empty/);
});

test('GitHub release checks ignore equal versions and reject prereleases', async t => {
  const { root } = fixture(t);
  const release = { tag_name: 'v1.0.3', draft: false, prerelease: false };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(release)));
  assert.equal(await updater.latest(root), null);
  release.tag_name = 'v1.0.4';
  assert.equal((await updater.latest(root)).tag_name, 'v1.0.4');
  release.prerelease = true;
  await assert.rejects(updater.latest(root), /Invalid stable release/);
});

test('GitHub network and HTTP errors are reported by explicit checks', async t => {
  const { root } = fixture(t);
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('limit', { status: 403 }));
  await assert.rejects(updater.latest(root), /HTTP 403/);
  mock.mock.mockImplementation(async () => { throw new Error('offline'); });
  await assert.rejects(updater.latest(root), /offline/);
});

test('downloaded bundle verifies checksums before applying and preserves local data', async t => {
  const { root, stage, next, data } = fixture(t);
  const zlib = require('node:zlib');
  const contents = Object.fromEntries(next.files.map(file => [file.path, fs.readFileSync(path.join(stage, file.path)).toString('base64')]));
  const compressed = zlib.gzipSync(JSON.stringify({ manifest: next, contents }));
  const name = 'epos-agent-v1.0.4.json.gz';
  const release = { tag_name: 'v1.0.4', assets: [
    { name, browser_download_url: `https://github.com/EPOS-ERIC/epos-agent/releases/download/v1.0.4/${name}` },
    { name: 'SHA256SUMS', browser_download_url: 'https://github.com/EPOS-ERIC/epos-agent/releases/download/v1.0.4/SHA256SUMS' }
  ] };
  let checksum = '0'.repeat(64);
  t.mock.method(globalThis, 'fetch', async url => new Response(url.endsWith('SHA256SUMS') ? `${checksum}  ${name}\n` : compressed));
  await assert.rejects(updater.update(root, release, () => assert.fail()), /checksum mismatch/);
  checksum = updater.hash(compressed);
  await updater.update(root, release, () => {});
  updater.verify(root, next);
  preserved(root, data);
});

test('download rejects untrusted URLs and excessive payloads', async t => {
  await assert.rejects(updater.download('https://example.org/package', 10), /Untrusted/);
  t.mock.method(globalThis, 'fetch', async () => new Response('too large'));
  await assert.rejects(updater.download('https://github.com/package', 2), /size limit/);
});

test('packager produces verifiable ZIP and bundle without runtime data', t => {
  const { directory } = fixture(t);
  const repository = path.join(directory, 'package source');
  fs.mkdirSync(repository);
  const source = path.resolve(__dirname, '../../..');
  const names = ['VERSION', 'install.sh', 'install.ps1', 'bin/epos-agent', 'bin/epos-agent.ps1', 'tools/updater/update.cjs', 'tools/updater/package.cjs'];
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
    fs.copyFileSync(path.join(source, name), path.join(repository, name));
  }
  fs.writeFileSync(path.join(repository, 'VERSION'), '2.0.0\n');
  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(process.execPath, ['tools/updater/package.cjs'], { cwd: repository, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: 'v2.0.0' } });
  assert.equal(result.status, 0, result.stderr);
  const compressed = fs.readFileSync(path.join(repository, 'dist/epos-agent-v2.0.0.json.gz'));
  const bundle = JSON.parse(require('node:zlib').gunzipSync(compressed));
  updater.validateManifest(bundle.manifest);
  for (const file of bundle.manifest.files) assert.equal(updater.hash(Buffer.from(bundle.contents[file.path], 'base64')), file.sha256);
  assert.match(fs.readFileSync(path.join(repository, 'dist/SHA256SUMS'), 'utf8'), new RegExp(updater.hash(compressed)));
  const extracted = path.join(directory, 'extracted');
  const unzip = spawnSync('python3', ['-m', 'zipfile', '-e', path.join(repository, 'dist/epos-agent-v2.0.0.zip'), extracted], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr);
  updater.init(extracted);
  updater.verify(extracted, bundle.manifest);
});

test('manifest rejects case collisions and file/directory conflicts', t => {
  const { next } = fixture(t);
  next.files.push({ ...next.files[0], path: 'version' });
  assert.throws(() => updater.validateManifest(next), /Duplicate/);
  next.files.pop();
  next.files.push({ path: 'bin', sha256: '0'.repeat(64), mode: 0o644 });
  assert.throws(() => updater.validateManifest(next), /directory/);
});

test('recovery pointer prevents new sessions until recovery completes', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, '.epos-update-recovery.json'), '{}');
  assert.throws(() => updater.session(root, String(process.pid)), /recover-update/);
});

test('an interrupted worker can restore its backup through the recovery command', t => {
  const { root, stage, old, next, data } = fixture(t);
  const manifestPath = path.join(stage, 'next.json');
  fs.writeFileSync(manifestPath, JSON.stringify(next));
  const script = `const u = require(process.argv[1]); const fs = require('node:fs'); u.applyRelease(process.argv[2], process.argv[3], JSON.parse(fs.readFileSync(process.argv[4])), () => process.exit(2));`;
  const modulePath = path.resolve(__dirname, '../update.cjs');
  const interrupted = spawnSync(process.execPath, ['-e', script, modulePath, root, stage, manifestPath], { encoding: 'utf8' });
  assert.equal(interrupted.status, 2, interrupted.stderr);
  assert.equal(fs.existsSync(path.join(root, '.epos-update-recovery.json')), true);
  const recovered = spawnSync(process.execPath, [modulePath, 'recover', root], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  updater.verify(root, old);
  preserved(root, data);
  assert.equal(fs.existsSync(path.join(root, '.epos-update-lock')), false);
  assert.equal(fs.existsSync(path.join(root, '.epos-update-recovery.json')), false);
});

test('recovery refuses to interfere with a live update worker', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, '.epos-update-lock'));
  fs.writeFileSync(path.join(root, '.epos-update-lock/pid'), String(process.pid));
  const recovered = spawnSync(process.execPath, [path.resolve(__dirname, '../update.cjs'), 'recover', root], { encoding: 'utf8' });
  assert.equal(recovered.status, 1);
  assert.match(recovered.stderr, /still running/);
  assert.equal(fs.existsSync(path.join(root, '.epos-update-lock')), true);
});

test('Unix launcher tracks sessions, forwards arguments and preserves runtime exit status', { skip: process.platform === 'win32' }, t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts/SYSTEM.md'), 'system prompt');
  const fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst fs = require('node:fs'); const path = require('node:path'); console.log('RUNTIME:' + JSON.stringify({ args: process.argv.slice(2), sessions: fs.readdirSync(path.join(process.env.EPOS_AGENT_ROOT, '.epos-sessions')) })); process.exit(Number(process.env.TEST_PI_EXIT || 0));\n`, { mode: 0o755 });
  // Session operations use the distributed updater at the installation path.
  fs.copyFileSync(path.resolve(__dirname, '../update.cjs'), path.join(root, 'tools/updater/update.cjs'));
  const launcher = path.resolve(__dirname, '../../../bin/epos-agent');
  const env = { ...process.env, EPOS_AGENT_ROOT: root, EPOS_SKIP_UPDATE_CHECK: '1', PI_BIN: fake, COLUMNS: '20' };
  const result = spawnSync('bash', [launcher, 'hello world'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RUNTIME:')).slice(8));
  assert.equal(runtime.args.at(-1), 'hello world');
  assert.equal(runtime.sessions.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, '.epos-sessions')), []);
  const failure = spawnSync('bash', [launcher], { encoding: 'utf8', env: { ...env, TEST_PI_EXIT: '23' } });
  assert.equal(failure.status, 23, failure.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, '.epos-sessions')), []);
});

test('dangling symlinks cannot redirect a newly distributed file', { skip: process.platform === 'win32' }, t => {
  const { root, stage, next, directory } = fixture(t);
  const outside = path.join(directory, 'outside.txt');
  fs.symlinkSync(outside, path.join(root, 'new.txt'));
  assert.throws(() => updater.applyRelease(root, stage, next, () => assert.fail()), /Symlink/);
  assert.equal(fs.existsSync(outside), false);
});
