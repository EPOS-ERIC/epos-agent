#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { sourceManifest, hash } = require('./update.cjs');
const root = path.resolve(__dirname, '../..');
const manifest = sourceManifest(root);
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) throw new Error('Tag must match VERSION');
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
fs.mkdirSync(output, { recursive: true });
const contents = Object.fromEntries(manifest.files.map(file => [file.path, fs.readFileSync(path.join(root, file.path)).toString('base64')]));
const name = `epos-agent-v${manifest.version}`;
fs.writeFileSync(path.join(output, `${name}.json.gz`), zlib.gzipSync(JSON.stringify({ manifest, contents })));
const result = spawnSync('python3', ['-c', `
import json, pathlib, sys, zipfile
root, output, name = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
manifest = json.loads(sys.stdin.read())
with zipfile.ZipFile(output / (name + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
    for item in manifest['files']:
        info = zipfile.ZipInfo(item['path'])
        info.external_attr = (0o100000 | item['mode']) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (root / item['path']).read_bytes())
    archive.writestr('release-manifest.json', json.dumps(manifest))
`, root, output, name], { input: JSON.stringify(manifest), encoding: 'utf8' });
if (result.error || result.status !== 0) throw new Error(result.stderr || 'ZIP packaging failed');
fs.writeFileSync(path.join(output, 'SHA256SUMS'), ['json.gz', 'zip'].map(ext => {
  const file = `${name}.${ext}`;
  return `${hash(fs.readFileSync(path.join(output, file)))}  ${file}\n`;
}).join(''));
console.log(`Packaged ${name}`);
