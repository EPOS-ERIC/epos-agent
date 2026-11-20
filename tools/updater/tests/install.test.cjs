'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epos-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const systemBin = path.join(directory, 'system bin');
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'new agent');
  for (const bin of [systemBin, path.join(home, '.local/bin'), path.join(root, 'bin')]) fs.mkdirSync(bin, { recursive: true });
  const launcher = path.join(root, 'bin/epos-agent');
  fs.writeFileSync(launcher, '#!/bin/sh\necho new agent\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  const script = fs.readFileSync(path.join(__dirname, '../../../install.sh'), 'utf8');
  const section = script.slice(script.indexOf('is_agent_launcher()'), script.indexOf("printf '\\n'", script.indexOf('is_agent_launcher()')))
    .replaceAll('/usr/local/bin', '"${TEST_SYSTEM_BIN}"').replaceAll('$HOME', '${TEST_HOME}');
  const run = (fallback = false, denyUnlink = false) => spawnSync('bash', ['-c', `
set -euo pipefail
say() { :; }
fail() { printf '%s\\n' "$*" >&2; exit 1; }
sudo() {
  if [[ "$1" == ln && "$TEST_FALLBACK" == 1 ]]; then return 1; fi
  if [[ "$1" == unlink && "$TEST_DENY_UNLINK" == 1 ]]; then return 1; fi
  "$@"
}
${section}`], {
    encoding: 'utf8', env: { ...process.env, INSTALL_ROOT: root, TEST_SYSTEM_BIN: systemBin,
      TEST_HOME: home, TEST_FALLBACK: fallback ? '1' : '0', TEST_DENY_UNLINK: denyUnlink ? '1' : '0' }
  });
  return { directory, launcher, system: path.join(systemBin, 'epos-agent'), local: path.join(home, '.local/bin/epos-agent'), run };
}

for (const fallback of [false, true]) {
  test(`reinstallation removes duplicate and broken links; fallback=${fallback}`, { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    const old = path.join(f.directory, 'old agent/bin/epos-agent');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'old launcher');
    fs.writeFileSync(path.join(f.directory, 'old agent/credentials'), 'keep credentials');
    fs.symlinkSync(old, f.system);
    fs.symlinkSync(path.join(f.directory, 'deleted agent/bin/epos-agent'), f.local);
    for (let i = 0; i < 2; i++) {
      const result = f.run(fallback);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(fallback ? f.local : f.system), fs.realpathSync(f.launcher));
      assert.equal(fs.lstatSync(fallback ? f.system : f.local, { throwIfNoEntry: false }), undefined);
    }
    assert.equal(fs.readFileSync(old, 'utf8'), 'old launcher');
    assert.equal(fs.readFileSync(path.join(f.directory, 'old agent/credentials'), 'utf8'), 'keep credentials');
  });
}

test('reinstallation replaces a recognizable copied launcher', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.local, 'echo "epos-agent: cannot find executable pi runtime"\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.local), false);
  assert.equal(fs.realpathSync(f.system), fs.realpathSync(f.launcher));
});

test('unrecognized commands are kept', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.system, 'another command');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(f.system, 'utf8'), 'another command');
});

test('directories at launcher paths are kept', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.mkdirSync(f.local);
  assert.notEqual(f.run(true).status, 0);
  assert.equal(fs.statSync(f.local).isDirectory(), true);
});

test('links to directories cannot redirect launcher installation', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const directory = path.join(f.directory, 'directory/bin/epos-agent');
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(directory, f.system);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('failure to remove a protected old launcher is reported', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.directory, 'old agent/bin/epos-agent'), f.system);
  const result = f.run(true, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not remove the previous launcher/);
  assert.equal(fs.lstatSync(f.system).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(f.local), fs.realpathSync(f.launcher));
});
