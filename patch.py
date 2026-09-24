import re

with open("tools/agent-runtime/index.ts", "r") as f:
    content = f.read()

# 1. Directories
content = re.sub(
    r'const dataDirectory = join\(study\.bundlePath, "data"\);\s*const figuresDirectory = join\(study\.bundlePath, "figures"\);\s*await mkdir\(dataDirectory, \{ recursive: true \}\);\s*await mkdir\(figuresDirectory, \{ recursive: true \}\);',
    '''const dataDirectory = join(study.bundlePath, "data");
  const codeDirectory = join(study.bundlePath, "code");
  const figuresDirectory = join(study.bundlePath, "figures");
  const notebooksDirectory = join(study.bundlePath, "notebooks");
  const metadataDirectory = join(study.bundlePath, "metadata");
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(codeDirectory, { recursive: true });
  await mkdir(figuresDirectory, { recursive: true });
  await mkdir(notebooksDirectory, { recursive: true });
  await mkdir(metadataDirectory, { recursive: true });''',
    content
)

# 2. Metadata files
content = content.replace('join(study.bundlePath, "manifest.json")', 'join(study.bundlePath, "metadata", "manifest.json")')
content = content.replace('join(study.bundlePath, "parameters.json")', 'join(study.bundlePath, "metadata", "parameters.json")')
content = content.replace('join(study.bundlePath, "provenance.json")', 'join(study.bundlePath, "metadata", "provenance.json")')
content = content.replace('join(study.bundlePath, "analysis-report.json")', 'join(study.bundlePath, "metadata", "analysis-report.json")')

content = content.replace('join(bundlePath, "manifest.json")', 'join(bundlePath, "metadata", "manifest.json")')
content = content.replace('join(bundlePath, "parameters.json")', 'join(bundlePath, "metadata", "parameters.json")')
content = content.replace('join(bundlePath, "provenance.json")', 'join(bundlePath, "metadata", "provenance.json")')

# 3. Code files
content = content.replace('join(bundlePath, "analysis.py")', 'join(bundlePath, "code", "analysis.py")')
content = content.replace('join(study.bundlePath, "analysis.py")', 'join(study.bundlePath, "code", "analysis.py")')
content = content.replace('join(bundlePath, "epos_viz")', 'join(bundlePath, "code", "epos_viz")')
content = content.replace('join(bundlePath, "visualization.schema.json")', 'join(bundlePath, "code", "visualization.schema.json")')
content = content.replace('join(bundlePath, "visualization.json")', 'join(bundlePath, "code", "visualization.json")')
content = content.replace('join(study.bundlePath, "visualization.json")', 'join(study.bundlePath, "code", "visualization.json")')

# 4. Notebook files
content = content.replace('join(study.bundlePath, "requirements.txt")', 'join(study.bundlePath, "notebooks", "requirements.txt")')
content = content.replace('join(study.bundlePath, `${study.slug}.ipynb`)', 'join(study.bundlePath, "notebooks", `${study.slug}.ipynb`)')

# 5. Remove Logs
content = re.sub(r'const PROV_DIR = join\(ROOT, "logs", "provenance"\);\n?', '', content)
content = re.sub(r'const TOKEN_LOG = join\(ROOT, "logs", "token-usage\.jsonl"\);\n?', '', content)
content = re.sub(r'await mkdir\(join\(ROOT, "logs"\), \{ recursive: true \}\);\n?', '', content)

# 6. logProvenance
old_log = '''async function logProvenance(record: Record<string, unknown>) {
  await mkdir(PROV_DIR, { recursive: true });
  const file = join(PROV_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${record.action || "epos"}.json`);
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}'''
new_log = '''async function logProvenance(record: Record<string, unknown>) {
  return record;
}'''
content = content.replace(old_log, new_log)

# 7. Rename provenanceFile -> provenanceRecord in the payload processing
content = content.replace('provenanceFile = await logProvenance', 'provenanceRecord = await logProvenance')
content = content.replace('provenance: { ...source, provenanceFile }', 'provenance: { ...source, provenanceRecord }')
content = content.replace('const provenanceFile = payload?.provenance?.provenanceFile;', 'const provenanceRecord = payload?.provenance?.provenanceRecord;')

# 8. State modification for provenanceRecords
content = content.replace('provenanceFiles: string[]', 'provenanceRecords: Record<string, unknown>[]')
content = content.replace('provenanceFiles: []', 'provenanceRecords: []')
content = content.replace('state.provenanceFiles = recentPaths([], ...(Array.isArray(candidate.provenanceFiles) ? candidate.provenanceFiles : []));',
                          'state.provenanceRecords = Array.isArray(candidate.provenanceRecords) ? candidate.provenanceRecords : [];')

# Fix withArtifacts
old_with = '''    provenanceFiles: recentPaths(state.provenanceFiles, provenanceFile),'''
new_with = '''    provenanceRecords: provenanceRecord ? [...state.provenanceRecords, provenanceRecord].slice(-MAX_STATE_FILES) : state.provenanceRecords,'''
content = content.replace(old_with, new_with)

# Fix error handling
old_err = '''      provenanceFiles: recentPaths(current.provenanceFiles, payload.provenanceFile),'''
new_err = '''      provenanceRecords: payload.provenanceRecord ? [...current.provenanceRecords, payload.provenanceRecord].slice(-MAX_STATE_FILES) : current.provenanceRecords,'''
content = content.replace(old_err, new_err)

# Fix writing provenance.json (which reads from state.provenanceRecords now, instead of files)
old_write_prov = '''  const provenanceRecords: unknown[] = [];
  for (const path of state.provenanceFiles) {
    try { provenanceRecords.push(JSON.parse(await readFile(path, "utf8"))); }
    catch { provenanceRecords.push({ provenanceFile: path, readable: false }); }
  }
  await writeFile(join(study.bundlePath, "provenance.json"), JSON.stringify({ records: provenanceRecords }, null, 2));'''
new_write_prov = '''  await writeFile(join(study.bundlePath, "metadata", "provenance.json"), JSON.stringify({ records: state.provenanceRecords }, null, 2));'''
content = content.replace(old_write_prov, new_write_prov)

with open("tools/agent-runtime/index.ts", "w") as f:
    f.write(content)

print("Patch applied")
