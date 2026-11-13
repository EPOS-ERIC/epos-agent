#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');

const API = 'https://api.github.com/repos/EPOS-ERIC/epos-agent/releases/latest';
const STATE = '.epos-update.json';
const LOCK = '.epos-update-lock';
const ENVS = ['.runtime', 'services/mcp-epos/.venv', 'services/mcp-fdsnws-event/.venv', 'tools/visualization/.venv'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJSON(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
const version = root => fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

function compare(a, b) {
  const parse = value => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid stable version: ${value}`);
    return value.split('.').map(BigInt);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function safeFile(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || /[\x00-\x1f]/.test(name)) throw new Error('Invalid package path');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error(`Unsafe package path: ${name}`);
  if (parts.some(p => ['.git', '.runtime', '.venv', 'node_modules', '__pycache__'].includes(p.toLowerCase())) ||
      /^(cache|sessions|logs)(\/|$)/i.test(name) ||
      (/^workspace(\/|$)/i.test(name) && name !== 'workspace/.gitkeep') ||
      (/^config(\/|$)/i.test(name) && name !== 'config/profile.env.example') ||
      (/^services\/mcp-epos\/artifacts(\/|$)/i.test(name) && name !== 'services/mcp-epos/artifacts/.gitkeep') ||
      /^\.epos-/i.test(name) || /^\.env(?:\.|$)/i.test(name)) throw new Error(`Protected package path: ${name}`);
  return name;
}

function validateManifest(manifest) {
  compare(manifest.version, manifest.version);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Empty release manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    safeFile(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || ![0o644, 0o755].includes(file.mode)) throw new Error('Invalid file metadata');
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate package path');
    seen.add(key);
  }
  for (const file of manifest.files) {
    const parts = file.path.toLowerCase().split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join('/'))) throw new Error('A package file cannot also be a directory');
    }
  }
  for (const name of ['VERSION', 'install.sh', 'install.ps1', 'bin/epos-agent', 'bin/epos-agent.ps1', 'tools/updater/update.cjs']) {
    if (!seen.has(name.toLowerCase())) throw new Error(`Missing release file: ${name}`);
  }
  return manifest;
}

function checkedPath(root, name) {
  safeFile(name);
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Symlink in managed path: ${name}`);
  }
  return current;
}

function verify(root, manifest) {
  validateManifest(manifest);
  for (const file of manifest.files) {
    const target = checkedPath(root, file.path);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile() || hash(fs.readFileSync(target)) !== file.sha256) throw new Error(`Missing or modified file: ${file.path}`);
  }
  if (version(root) !== manifest.version) throw new Error('VERSION and manifest disagree');
}

function sourceManifest(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--stage'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Use the official release ZIP or initialize from a Git checkout.');
  const files = result.stdout.split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) [a-f0-9]+ \d\t(.+)$/.exec(entry);
    if (!match) throw new Error('Unsupported Git entry');
    const name = safeFile(match[2]);
    return { path: name, sha256: hash(fs.readFileSync(checkedPath(root, name))), mode: match[1] === '100755' ? 0o755 : 0o644 };
  });
  return validateManifest({ version: version(root), files });
}

function patchPi(root) {
  const file = path.join(root, '.runtime/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js');
  if (!fs.existsSync(file)) return;
  let code = fs.readFileSync(file, 'utf8');
  const target = 'async handleLoginCommand(providerRef) {';
  const replacement = target + '\n        this.showStatus(`Pi documentation: ${path.join(getDocsPath(), "providers.md")}`);';
  if (code.includes(target) && !code.includes('Pi documentation:')) {
    code = code.replace(target, replacement);
    fs.writeFileSync(file, code);
  }
}

function copySource(root, destination) {
  if (root === destination) return;
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('Choose an empty installation directory. Use epos-agent update for an existing installation.');
  const source = path.join(root, 'release-manifest.json');
  const manifest = fs.existsSync(source) ? readJSON(source) : sourceManifest(root);
  verify(root, manifest);
  fs.mkdirSync(destination, { recursive: true });
  for (const file of manifest.files) {
    const target = path.join(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file.path), target);
    fs.chmodSync(target, file.mode);
  }
  fs.writeFileSync(path.join(destination, 'release-manifest.json'), JSON.stringify(manifest));
}

function init(root) {
  if (fs.existsSync(path.join(root, STATE))) {
    verify(root, readJSON(path.join(root, STATE)));
    return;
  }
  const releaseManifest = path.join(root, 'release-manifest.json');
  if (!fs.existsSync(releaseManifest)) {
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
    if (status.status !== 0 || status.stdout.trim()) throw new Error('Commit or discard tracked code changes before initializing updates.');
  }
  const manifest = fs.existsSync(releaseManifest) ? readJSON(releaseManifest) : sourceManifest(root);
  verify(root, manifest);
  fs.writeFileSync(path.join(root, STATE), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
}

function withLock(root, callback) {
  const lock = path.join(root, LOCK);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another update is running, or an interrupted update requires recovery.');
    throw error;
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  try { return callback(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function liveSessions(root) {
  const directory = path.join(root, '.epos-sessions');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(pid => {
    if (!/^\d+$/.test(pid)) throw new Error('Invalid session marker');
    try { process.kill(Number(pid), 0); return true; } catch (error) {
      if (error.code !== 'ESRCH') return true;
      fs.unlinkSync(path.join(directory, pid));
      return false;
    }
  });
}

function session(root, pid, end = false) {
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('Invalid session PID');
  const directory = path.join(root, '.epos-sessions');
  if (end) { fs.rmSync(path.join(directory, pid), { force: true }); return; }
  if (fs.existsSync(path.join(root, '.epos-update-recovery.json'))) throw new Error('An interrupted update requires epos-agent recover-update.');
  withLock(root, () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, pid), '');
  });
}

function install(root) {
  const win = process.platform === 'win32';
  const result = spawnSync(win ? 'powershell.exe' : '/bin/bash', win ?
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1'), '-UpdateDependenciesOnly'] :
    [path.join(root, 'install.sh')], {
    stdio: 'inherit', cwd: root,
    env: { ...process.env, EPOS_INSTALL_ROOT: root, EPOS_UPDATE_IN_PROGRESS: '1' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dependency installation failed (${result.status})`);
  const python = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  for (const directory of ENVS.slice(1)) {
    const check = spawnSync(path.join(root, directory, python), ['-m', 'pip', 'check'], { stdio: 'inherit' });
    if (check.error || check.status !== 0) throw new Error(`Dependency verification failed: ${directory}`);
  }
  const piRoot = path.join(root, '.runtime/node_modules/@earendil-works/pi-coding-agent');
  const piPackage = readJSON(path.join(piRoot, 'package.json'));
  const pi = path.join(piRoot, piPackage.bin.pi);
  const check = spawnSync(process.execPath, [pi, '--version'], { stdio: 'inherit' });
  if (check.error || check.status !== 0) throw new Error('Pi runtime verification failed');
}

function applyRelease(root, stage, manifest, installDependencies = install) {
  verify(stage, manifest);
  return withLock(root, () => {
    if (fs.existsSync(path.join(root, '.epos-update-recovery.json'))) throw new Error('Run epos-agent recover-update before updating.');
    if (liveSessions(root).length) throw new Error('Close all EPOS Agent sessions before updating.');
    for (const name of ENVS) {
      let target = root;
      for (const part of name.split('/')) {
        target = path.join(target, part);
        if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Symlink in runtime path: ${name}`);
      }
    }
    const previous = readJSON(path.join(root, STATE));
    verify(root, previous);
    if (compare(manifest.version, previous.version) <= 0) throw new Error('The release must be newer than the installed version.');
    const oldNames = new Set(previous.files.map(f => f.path));
    const names = [...new Set([...oldNames, ...manifest.files.map(f => f.path)])];
    for (const file of manifest.files) {
      const target = checkedPath(root, file.path);
      if (!oldNames.has(file.path) && fs.existsSync(target)) throw new Error(`Local file would be overwritten: ${file.path}`);
    }
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'epos-backup-'));
    const existing = names.filter(name => fs.existsSync(checkedPath(root, name)));
    const environments = ENVS.filter(name => fs.existsSync(path.join(root, name)));
    for (const name of [...existing, ...environments, STATE]) {
      const destination = path.join(backup, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(root, name), destination, { recursive: true, verbatimSymlinks: true });
    }
    // Keep a recovery pointer if the process is interrupted or rollback itself fails.
    const recovery = path.join(root, '.epos-update-recovery.json');
    writeJSON(recovery, { backup, names, existing, environments });
    try {
      for (const name of names) fs.rmSync(checkedPath(root, name), { force: true });
      for (const file of manifest.files) {
        const target = checkedPath(root, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(stage, file.path), target);
        fs.chmodSync(target, file.mode);
      }
      installDependencies(root);
      verify(root, manifest);
      writeJSON(path.join(root, STATE), manifest);
    } catch (error) {
      try { restore(root, { backup, names, existing, environments }); } catch (rollbackError) {
        throw new Error(`${error.message}; rollback failed: ${rollbackError.message}. Recovery: ${backup}`);
      }
      throw error;
    }
    fs.rmSync(path.join(root, 'release-manifest.json'), { force: true });
    fs.rmSync(recovery, { force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  });
}

function restore(root, recovery) {
  const { backup, names, existing, environments } = recovery;
  for (const name of names) fs.rmSync(checkedPath(root, name), { force: true });
  for (const name of ENVS) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  for (const name of [...existing, ...environments, STATE]) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(backup, name), target, { recursive: true, verbatimSymlinks: true });
  }
  fs.rmSync(path.join(root, '.epos-update-recovery.json'), { force: true });
  fs.rmSync(backup, { recursive: true, force: true });
}

async function download(url, maxBytes, timeout = 120000) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com'].includes(parsed.hostname)) throw new Error('Untrusted release URL');
  const response = await fetch(url, { headers: { 'User-Agent': 'epos-agent-updater', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Release response exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function latest(root) {
  const release = JSON.parse(await download(API, 2 * 1024 * 1024, 5000));
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Invalid stable release');
  const available = release.tag_name.slice(1);
  return compare(available, version(root)) > 0 ? release : null;
}

async function update(root, release, installDependencies = install) {
  const name = `epos-agent-${release.tag_name}.json.gz`;
  const asset = release.assets.find(item => item.name === name);
  const sums = release.assets.find(item => item.name === 'SHA256SUMS');
  if (!asset || !sums) throw new Error('Release package or checksum is missing');
  const checksums = (await download(sums.browser_download_url, 100000)).toString('utf8');
  const expected = checksums.split(/\r?\n/).map(line => line.split(/\s+/)).find(parts => parts[1] === name)?.[0];
  const compressed = await download(asset.browser_download_url, 100 * 1024 * 1024);
  if (!/^[a-f0-9]{64}$/.test(expected || '') || hash(compressed) !== expected) throw new Error('Release checksum mismatch');
  const bundle = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }));
  const manifest = validateManifest(bundle.manifest);
  if (`v${manifest.version}` !== release.tag_name) throw new Error('Tag and package version disagree');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'epos-stage-'));
  try {
    for (const file of manifest.files) {
      const target = path.join(stage, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(bundle.contents[file.path], 'base64'), { mode: file.mode });
    }
    applyRelease(root, stage, manifest, installDependencies);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  console.log(`[EPOS] Updated to ${manifest.version}.`);
}

async function main() {
  const [command, rootArg, ...args] = process.argv.slice(2);
  if (!rootArg) throw new Error('Installation directory is required');
  const root = fs.realpathSync(rootArg);
  if (command === 'init') return init(root);
  if (command === 'patch-pi') return patchPi(root);
  if (command === 'copy') return copySource(root, path.resolve(args[0]));
  if (command === 'session') return session(root, args[0], args[1] === 'end');
  if (command === 'recover') {
    const ownerFile = path.join(root, LOCK, 'pid');
    if (fs.existsSync(ownerFile)) {
      const owner = fs.readFileSync(ownerFile, 'utf8');
      if (!/^[1-9]\d*$/.test(owner)) throw new Error('Invalid update lock owner');
      let alive = true;
      try { process.kill(Number(owner), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('An updater is still running.');
    }
    if (liveSessions(root).length) throw new Error('Close all sessions before recovery.');
    fs.rmSync(path.join(root, LOCK), { recursive: true, force: true });
    return withLock(root, () => {
      const recovery = path.join(root, '.epos-update-recovery.json');
      if (fs.existsSync(recovery)) restore(root, readJSON(recovery));
      console.log('[EPOS] Recovery completed.');
    });
  }
  if (!['startup', 'update', 'worker'].includes(command)) throw new Error('Unknown updater command');
  if (command === 'startup' && (!process.stdin.isTTY || !process.stdout.isTTY || process.env.EPOS_SKIP_UPDATE_CHECK === '1')) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    if (command === 'startup') return;
    throw new Error('The release updater currently supports Windows and macOS.');
  }
  if (!fs.existsSync(path.join(root, STATE))) {
    if (command === 'startup') return;
    throw new Error('Run the installer once to initialize updates.');
  }
  if (command === 'worker') return update(root, JSON.parse(args[0]));
  let release;
  try { release = await latest(root); } catch (error) {
    if (command !== 'startup') throw error;
    console.error(`[EPOS] Update check unavailable: ${error.message}`);
    return;
  }
  if (!release) { if (command !== 'startup') console.log('[EPOS] Already up to date.'); return; }
  console.log(`[EPOS] New version available: ${release.tag_name} (installed: ${version(root)}).`);
  if (args.includes('--check')) return;
  if (command === 'startup') {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await prompt.question('[EPOS] Update now? [y/N] '); } finally { prompt.close(); }
    if (!/^(y|yes|s|si|sì)$/i.test(answer.trim())) return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'epos-updater-'));
  try {
    const worker = path.join(temporary, 'update.cjs');
    fs.copyFileSync(__filename, worker);
    const result = spawnSync(process.execPath, [worker, 'worker', root, JSON.stringify(release)], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Update failed; inspect the error above.');
    if (command === 'startup') process.exitCode = 10;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { hash, compare, safeFile, validateManifest, verify, sourceManifest, init, copySource, session, liveSessions, applyRelease, restore, latest, download, update };
if (require.main === module) main().catch(error => { console.error(`[EPOS] ${error.message}`); process.exitCode = 1; });
