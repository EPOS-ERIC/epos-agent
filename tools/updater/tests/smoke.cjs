'use strict';
// CI-only integration: uses the real installed dependencies and performs no downloads.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { applyRelease, hash, verify } = require('../update.cjs');
const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.epos-update.json'), 'utf8'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'epos-smoke-'));
try {
  const [major, minor, patch] = manifest.version.split('.').map(Number);
  const next = { version: `${major}.${minor}.${patch + 1}`, files: manifest.files.map(file => ({ ...file })) };
  for (const file of next.files) {
    const destination = path.join(stage, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const content = file.path === 'VERSION' ? Buffer.from(next.version + '\n') : fs.readFileSync(path.join(root, file.path));
    fs.writeFileSync(destination, content); file.sha256 = hash(content);
  }
  const auth = path.join(root, 'config/pi-agent/updater-smoke.json');
  fs.writeFileSync(auth, 'preserve-me');
  applyRelease(root, stage, next);
  verify(root, next);
  if (fs.readFileSync(auth, 'utf8') !== 'preserve-me') throw new Error('Local state changed');
  const win = process.platform === 'win32';
  const launch = spawnSync(win ? 'powershell.exe' : 'bash', win ?
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'bin/epos-agent.ps1'), '--version'] :
    [path.join(root, 'bin/epos-agent'), '--version'], { encoding: 'utf8' });
  if (launch.status !== 0 || launch.stdout.trim() !== next.version) throw new Error('Updated launcher failed');
  console.log(`Real installation updated to ${next.version}`);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
