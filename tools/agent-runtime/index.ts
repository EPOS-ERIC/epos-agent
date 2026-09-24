import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, appendFile, cp, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface, type Interface } from "node:readline";

const ROOT = process.env.EPOS_AGENT_ROOT || `${process.env.HOME}/epos-agent`;
const PROV_DIR = join(ROOT, "logs", "provenance");
const TOKEN_LOG = join(ROOT, "logs", "token-usage.jsonl");
const FDSN_CMD = join(ROOT, "services", "mcp-fdsnws-event", ".venv", "bin", "mcp-fdsnws-event-server");
const EPOS_MCP_PYTHON = join(ROOT, "services", "mcp-epos", ".venv", "bin", "python");
const EPOS_MCP_SERVER = join(ROOT, "services", "mcp-epos", "tools", "epos_mcp_stdio.py");
const EPOS_MCP_ARTIFACTS = resolve(ROOT, "services", "mcp-epos", "artifacts");
const WORKSPACE = resolve(ROOT, "workspace");
const VISUALIZATION_ROOT = resolve(ROOT, "tools", "visualization");
const VISUALIZATION_TEMPLATE = join(VISUALIZATION_ROOT, "templates");
const ANALYSIS_ENV = join(VISUALIZATION_ROOT, ".venv");
const ANALYSIS_PYTHON = join(ANALYSIS_ENV, "bin", "python");
const MCP_PROTOCOL_VERSION = "2025-11-25";
const FDSN_PAGE_SIZE = 1000;
const FDSN_INITIAL_SHARD_MS = 31 * 24 * 60 * 60 * 1000;
const FDSN_SAMPLE_SIZE = 5;
const MODEL_RESULT_LIMIT = 12000;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const CONVERSATION_STATE_TYPE = "epos-conversation-state";
const MAX_STATE_FILES = 100;

type StateValue = string | number | boolean;
type WorkflowPhase = "context" | "question" | "services" | "download" | "visualization" | "code" | "complete";
type StudyService = {
  resourceId: string;
  title: string;
  role: string;
  format?: string;
  estimatedBytes?: number;
};
type StudyState = {
  id: string;
  title: string;
  slug: string;
  bundlePath: string;
  context: string;
  scientificQuestion: string;
  phase: WorkflowPhase;
  services: StudyService[];
  confirmed: boolean;
  budgetBytes: number;
  downloadedBytes: number;
  createdAt: string;
  visualizationVersion?: 2;
};
type ConversationState = {
  version: 2;
  intent?: string;
  domain?: string;
  filters: Record<string, StateValue>;
  selectedResourceId?: string;
  format?: string;
  files: string[];
  provenanceFiles: string[];
  study?: StudyState;
  updatedAt: string;
};

function emptyConversationState(): ConversationState {
  return { version: 2, filters: {}, files: [], provenanceFiles: [], updatedAt: now() };
}

let runtimeConversationState = emptyConversationState();

function withoutEmptyValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    const values = value.map(withoutEmptyValues).filter(item => item !== undefined);
    return values.length ? values : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, withoutEmptyValues(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function modelConversationState(state: ConversationState) {
  const study = state.study;
  return withoutEmptyValues({
    intent: state.intent,
    domain: state.domain,
    filters: state.filters,
    selectedResourceId: state.selectedResourceId,
    format: state.format,
    files: state.files,
    study: study ? {
      id: study.id,
      title: study.title,
      bundlePath: study.bundlePath,
      context: study.context,
      scientificQuestion: study.scientificQuestion,
      phase: study.phase,
      services: study.services,
      confirmed: study.confirmed,
      budgetBytes: study.budgetBytes,
      downloadedBytes: study.downloadedBytes,
    } : undefined,
  }) || {};
}

function stateValue(value: unknown): StateValue | undefined {
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function pickStateFilters(input: Record<string, unknown>, keys: string[]) {
  const filters: Record<string, StateValue> = {};
  for (const key of keys) {
    const value = stateValue(input[key]);
    if (value !== undefined) filters[key] = value;
  }
  const serviceParameters = input.serviceParameters;
  if (serviceParameters && typeof serviceParameters === "object" && !Array.isArray(serviceParameters)) {
    for (const [key, raw] of Object.entries(serviceParameters).slice(0, 20)) {
      const value = stateValue(raw);
      if (value !== undefined) filters[`service.${key.slice(0, 80)}`] = value;
    }
  }
  return filters;
}

function recentPaths(current: string[], ...values: unknown[]) {
  const paths = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set([...current, ...paths])].slice(-MAX_STATE_FILES);
}

function storedConversationState(data: unknown): ConversationState | undefined {
  if (!data || typeof data !== "object" || ![1, 2].includes((data as any).version)) return undefined;
  const candidate = data as any;
  const state = emptyConversationState();
  state.intent = typeof candidate.intent === "string" ? candidate.intent : undefined;
  state.domain = typeof candidate.domain === "string" ? candidate.domain : undefined;
  state.selectedResourceId = typeof candidate.selectedResourceId === "string" ? candidate.selectedResourceId : undefined;
  state.format = typeof candidate.format === "string" ? candidate.format : undefined;
  state.updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : state.updatedAt;
  state.filters = pickStateFilters(candidate.filters && typeof candidate.filters === "object" ? candidate.filters : {}, Object.keys(candidate.filters || {}).slice(0, 30));
  state.files = recentPaths([], ...(Array.isArray(candidate.files) ? candidate.files : []));
  state.provenanceFiles = recentPaths([], ...(Array.isArray(candidate.provenanceFiles) ? candidate.provenanceFiles : []));
  if (candidate.version === 2 && candidate.study && typeof candidate.study === "object") {
    const study = candidate.study;
    const bundlePath = typeof study.bundlePath === "string" ? resolve(study.bundlePath) : "";
    if (bundlePath === WORKSPACE || bundlePath.startsWith(WORKSPACE + sep)) {
      state.study = {
        id: String(study.id || ""),
        title: String(study.title || "Untitled study").slice(0, 200),
        slug: safeName(study.slug || study.title || "study"),
        bundlePath,
        context: String(study.context || "").slice(0, 4000),
        scientificQuestion: String(study.scientificQuestion || "").slice(0, 4000),
        phase: ["context", "question", "services", "download", "visualization", "code", "complete"].includes(study.phase) ? study.phase : "context",
        services: Array.isArray(study.services) ? study.services.slice(0, 100) : [],
        confirmed: Boolean(study.confirmed),
        budgetBytes: MAX_DOWNLOAD_BYTES,
        downloadedBytes: Math.max(0, Number(study.downloadedBytes) || 0),
        createdAt: typeof study.createdAt === "string" ? study.createdAt : now(),
        visualizationVersion: study.visualizationVersion === 2 ? 2 : undefined,
      };
    }
  }
  return state;
}

function activeStudyDataDirectory() {
  return runtimeConversationState.study ? join(runtimeConversationState.study.bundlePath, "data") : WORKSPACE;
}

function remainingStudyBudget() {
  const study = runtimeConversationState.study;
  return study ? Math.max(0, study.budgetBytes - study.downloadedBytes) : MAX_DOWNLOAD_BYTES;
}

function requireConfirmedStudy() {
  const study = runtimeConversationState.study;
  if (study && !study.confirmed) throw new Error("The study download plan requires the researcher's single confirmation before downloading.");
}

function restoreConversationState(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry: any = entries[index];
    if (entry.type === "custom" && entry.customType === CONVERSATION_STATE_TYPE) {
      return storedConversationState(entry.data) || emptyConversationState();
    }
  }
  return emptyConversationState();
}

function toolPayload(event: any) {
  const text = event.content?.find((item: any) => item.type === "text")?.text;
  if (event.isError && typeof text === "string") {
    try { return JSON.parse(text); }
    catch {}
  }
  if (event.details && typeof event.details === "object") return event.details;
  if (typeof text === "string") {
    try { return JSON.parse(text); }
    catch {}
  }
  return {};
}

const EPOS_FILTER_KEYS = ["q", "startDate", "endDate", "bbox", "keywords", "scienceDomains", "serviceTypes", "organizations", "versioningStatus"];
const FDSN_FILTER_KEYS = ["starttime", "endtime", "updatedafter", "minmag", "maxmag", "mindepth", "maxdepth", "minlat", "maxlat", "minlon", "maxlon", "latitude", "longitude", "minradiuskm", "maxradiuskm", "eventid", "datacenter", "orderby", "limit"];

function nextConversationState(current: ConversationState, event: any): ConversationState | undefined {
  const input = (event.input || {}) as Record<string, any>;
  const payload = toolPayload(event);
  const provenanceFile = payload?.provenance?.provenanceFile;
  const withArtifacts = (state: ConversationState, ...files: unknown[]) => ({
    ...state,
    files: recentPaths(state.files, ...files),
    provenanceFiles: recentPaths(state.provenanceFiles, provenanceFile),
    updatedAt: now(),
  });

  if (event.isError) {
    if (!payload?.outputFile) return undefined;
    const partialBytes = Math.max(0, Number(payload.bytes) || 0);
    return {
      ...current,
      files: recentPaths(current.files, payload.outputFile),
      provenanceFiles: recentPaths(current.provenanceFiles, payload.provenanceFile),
      study: current.study ? {
        ...current.study,
        downloadedBytes: Math.min(current.study.budgetBytes, current.study.downloadedBytes + partialBytes),
      } : undefined,
      updatedAt: now(),
    };
  }

  if (event.toolName === "epos_manage_study") {
    return storedConversationState(payload.state);
  }

  if (event.toolName === "epos_load_tools") {
    const intentByCapability: Record<string, string> = {
      catalog_search: "find_data", description: "describe_data",
      download: "download_data", seismology: "find_earthquakes", analysis: "analyze_data", workspace: "manage_workspace",
      workflow: "manage_study",
    };
    const intent = intentByCapability[input.capability];
    if (!intent) return undefined;
    return { ...current, intent, domain: input.capability === "seismology" ? "seismology" : current.domain, updatedAt: now() };
  }

  if (event.toolName === "epos_mcp_call") {
    const tool = input.tool;
    const args = input.arguments && typeof input.arguments === "object" ? input.arguments : {};
    if (["epos_search", "epos_search_page", "epos_search_filter", "epos_organizations"].includes(tool)) {
      return withArtifacts({
        ...current,
        intent: "find_data",
        filters: pickStateFilters(args, ["q", "query", "startDate", "endDate", "bbox", "organisations"]),
      });
    }
    if (tool === "epos_details" || tool === "epos_select_candidate") {
      return withArtifacts({
        ...current,
        intent: "describe_data",
        selectedResourceId: typeof args.distribution_id === "string" ? args.distribution_id : current.selectedResourceId,
      });
    }
    if (tool === "epos_prepare_execute" || tool === "epos_execute") {
      const downloadedBytes = tool === "epos_execute" ? Math.max(0, Number(payload.bytes) || 0) : 0;
      return withArtifacts({
        ...current,
        intent: tool === "epos_execute" ? "download_data" : "prepare_download",
        selectedResourceId: typeof args.distribution_id === "string" ? args.distribution_id : current.selectedResourceId,
        study: current.study ? {
          ...current.study,
          phase: tool === "epos_execute" ? "download" : "services",
          downloadedBytes: Math.min(current.study.budgetBytes, current.study.downloadedBytes + downloadedBytes),
        } : undefined,
      }, payload.outputFile);
    }
    return withArtifacts(current);
  }

  if (event.toolName === "epos_search_resources" || event.toolName === "epos_search_software") {
    const filters = pickStateFilters(input, EPOS_FILTER_KEYS);
    return withArtifacts({
      ...current,
      intent: event.toolName === "epos_search_software" ? "find_software" : "find_data",
      domain: typeof input.scienceDomains === "string" ? input.scienceDomains : current.domain,
      filters,
    }, undefined);
  }

  if (["epos_describe_resource", "epos_describe_service", "epos_describe_software"].includes(event.toolName)) {
    return withArtifacts({
      ...current,
      intent: event.toolName === "epos_describe_software" ? "describe_software" : "describe_data",
      selectedResourceId: typeof input.resourceId === "string" ? input.resourceId : current.selectedResourceId,
    });
  }

  if (event.toolName === "epos_execute_service") {
    const filters = { ...current.filters, ...pickStateFilters(input, EPOS_FILTER_KEYS) };
    const downloadedBytes = input.estimateOnly ? 0 : Math.max(0, Number(payload.bytes) || 0);
    return withArtifacts({
      ...current,
      intent: input.estimateOnly ? "prepare_download" : "download_data",
      filters,
      selectedResourceId: typeof input.resourceId === "string" ? input.resourceId : current.selectedResourceId,
      format: typeof input.format === "string" ? input.format : current.format,
      study: current.study ? {
        ...current.study,
        phase: input.estimateOnly ? "services" : "download",
        downloadedBytes: Math.min(current.study.budgetBytes, current.study.downloadedBytes + downloadedBytes),
      } : undefined,
    }, payload.outputFile, payload.file, payload.path);
  }

  if (event.toolName === "epos_fdsnws_event_call") {
    const args = input.arguments && typeof input.arguments === "object" ? input.arguments : {};
    if (input.toolName === "fdsn_query_earthquakes") {
      const downloadedBytes = Math.max(0, Number(payload.bytes) || 0);
      return withArtifacts({
        ...current,
        intent: "download_data",
        domain: "seismology",
        filters: pickStateFilters(args, FDSN_FILTER_KEYS),
        format: "jsonl",
        study: current.study ? {
          ...current.study,
          phase: "download",
          downloadedBytes: Math.min(current.study.budgetBytes, current.study.downloadedBytes + downloadedBytes),
        } : undefined,
      }, payload.outputFile);
    }
    return withArtifacts({
      ...current,
      intent: "inspect_event",
      domain: "seismology",
      filters: { ...current.filters, ...pickStateFilters(args, FDSN_FILTER_KEYS) },
      study: current.study && payload.outputFile ? {
        ...current.study,
        downloadedBytes: Math.min(current.study.budgetBytes, current.study.downloadedBytes + Math.max(0, Number(payload.bytes) || 0)),
      } : current.study,
    }, payload.outputFile);
  }

  if (event.toolName === "epos_run_python") {
    return withArtifacts({
      ...current,
      intent: "analyze_data",
      study: current.study ? { ...current.study, phase: input.outputImagePath || payload.outputs?.length ? "visualization" : "code" } : undefined,
    }, payload.script, payload.reportPath, payload.outputLog, input.outputImagePath, ...(Array.isArray(payload.outputs) ? payload.outputs : []));
  }
  if (event.toolName === "epos_prepare_visualization") {
    return withArtifacts({
      ...current,
      intent: "analyze_data",
      study: current.study ? { ...current.study, phase: "code" } : undefined,
    }, payload.analysisPath, payload.configPath);
  }
  if (event.toolName === "epos_finalize_notebook") {
    return withArtifacts({
      ...current,
      intent: "analyze_data",
      study: current.study ? { ...current.study, phase: "complete" } : undefined,
    }, payload.notebookPath, payload.requirementsPath, payload.reportPath);
  }
  if (event.toolName === "epos_show_image") {
    return withArtifacts({ ...current, intent: "visualize_data" }, payload.path, input.path);
  }
  return undefined;
}
function isInsideWorkspace(p: string, cwd: string) {
  const target = resolve(cwd, p);
  return target === WORKSPACE || target.startsWith(WORKSPACE + sep);
}

function resolveWorkspacePath(p: string, relativeBase = WORKSPACE) {
  const target = resolve(relativeBase, p);
  if (target !== WORKSPACE && !target.startsWith(WORKSPACE + sep)) {
    throw new Error(`Path must be inside ${WORKSPACE}`);
  }
  return target;
}

class StdioMcpClient {
  constructor(private command: string, private args: string[] = [], private cwd = ROOT, private env: NodeJS.ProcessEnv = {}) {}
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  async start() {
    if (this.proc && !this.proc.killed) return;
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => { /* keep stderr off stdout; inspect logs/mcp-smoke.err for smoke tests */ });
    this.proc.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.proc = undefined;
    });
    this.proc.on("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP process exited: ${this.command}`));
      this.pending.clear();
      this.proc = undefined;
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } catch {}
    });
    await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "epos-agent", version: "0.2.0" } });
    this.notify("notifications/initialized", {});
  }
  request(method: string, params: any) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error(`MCP process is not running: ${this.command}`);
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }
  notify(method: string, params: any) {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async stop() { this.rl?.close(); if (this.proc && !this.proc.killed) this.proc.kill(); }
}
const mcp = new StdioMcpClient(FDSN_CMD, [], join(ROOT, "services", "mcp-fdsnws-event"));
const eposMcp = new StdioMcpClient(EPOS_MCP_PYTHON, [EPOS_MCP_SERVER], join(ROOT, "services", "mcp-epos"), { EPOS_MCP_LOCAL_PATHS: "1" });
async function eposMcpCall(toolName: string, args: Record<string, unknown>) {
  await eposMcp.start();
  const response = await eposMcp.request("tools/call", { name: toolName, arguments: args });
  if (response?.isError) {
    const text = response.content?.find((c: any) => c.type === "text")?.text || `EPOS MCP tool failed: ${toolName}`;
    const error = new Error(text);
    try { Object.assign(error, JSON.parse(text)); }
    catch {}
    throw error;
  }
  if (response?.structuredContent) return response.structuredContent;
  const text = response?.content?.find((c: any) => c.type === "text")?.text;
  if (!text) throw new Error(`EPOS MCP returned no text for ${toolName}`);
  return JSON.parse(text);
}

const execFileAsync = promisify(execFile);
function imageMime(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}
async function imageBlock(path: string) {
  const mimeType = imageMime(path);
  if (!mimeType) throw new Error(`Unsupported image type for inline display: ${path}`);
  const data = (await readFile(path)).toString("base64");
  return { type: "image" as const, data, mimeType };
}

function now() { return new Date().toISOString(); }
async function logProvenance(record: Record<string, unknown>) {
  await mkdir(PROV_DIR, { recursive: true });
  const file = join(PROV_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${record.action || "epos"}.json`);
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}
function modelResult(payload: unknown, modelPayload: unknown = payload) {
  const serialized = JSON.stringify(modelPayload);
  if (serialized.length <= MODEL_RESULT_LIMIT) return { content: [{ type: "text" as const, text: serialized }], details: payload };
  const compact = { truncatedInChat: true, characterCount: serialized.length, preview: serialized.slice(0, MODEL_RESULT_LIMIT) };
  return { content: [{ type: "text" as const, text: JSON.stringify(compact) }], details: payload };
}
async function resultWithProvenance(action: string, parameters: Record<string, unknown>, payload: any) {
  const source = payload?.provenance || {};
  const record = { action, timestamp: source.retrievedAt || now(), parameters, ...source };
  const provenanceFile = await logProvenance(record);
  const result = { ...payload, provenance: { ...record, provenanceFile } };
  const modelProvenance = withoutEmptyValues({ ...record, parameters: undefined });
  const modelPayload = withoutEmptyValues({ ...payload, provenance: { ...(modelProvenance as object), provenanceFile } }) || {};
  return modelResult(result, modelPayload);
}
function parseMcpPayload(result: any) {
  const text = result?.content?.find((item: any) => item.type === "text")?.text;
  if (result?.isError) throw new Error(text || "MCP tool call failed");
  if (result?.structuredContent) {
    const structured = result.structuredContent;
    if (Object.keys(structured).length === 1 && typeof structured.result === "string") {
      try { return JSON.parse(structured.result); }
      catch { throw new Error("MCP tool returned invalid JSON in structuredContent.result"); }
    }
    return structured;
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { text }; }
}
function safeName(value: unknown) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function writeIfMissing(path: string, content: string) {
  try { await access(path); }
  catch { await writeFile(path, content); }
}

async function ensureVisualizationTemplate(bundlePath: string) {
  await writeIfMissing(join(bundlePath, "analysis.py"), await readFile(join(VISUALIZATION_TEMPLATE, "analysis.py"), "utf8"));
  const packagePath = join(bundlePath, "epos_viz");
  try { await access(packagePath); }
  catch { await cp(join(VISUALIZATION_TEMPLATE, "epos_viz"), packagePath, { recursive: true }); }
  await writeIfMissing(join(bundlePath, "visualization.schema.json"), await readFile(join(VISUALIZATION_TEMPLATE, "visualization.schema.json"), "utf8"));
  await writeIfMissing(join(bundlePath, "visualization.json"), JSON.stringify({
    version: 2,
    recipe: { name: "custom" },
    datasets: [],
    map: { basemap: "satellite", topography: false },
    interactive: false,
  }, null, 2) + "\n");
}

async function visualizationDataFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await visualizationDataFiles(path));
    else if (entry.isFile() && [".csv", ".json", ".jsonl", ".geojson", ".tif", ".tiff", ".parquet", ".gpkg", ".shp", ".xml", ".qml", ".mseed", ".msd", ".seed"].includes(extname(path).toLowerCase()) && !entry.name.includes(".partial.")) files.push(path);
  }
  return files.sort();
}

async function analysisPython() {
  try {
    await access(ANALYSIS_PYTHON);
    return ANALYSIS_PYTHON;
  } catch {
    return "python3";
  }
}

async function ensureAnalysisEnvironment(optionalDependencies: string[] = []) {
  try { await access(ANALYSIS_PYTHON); }
  catch {
    await mkdir(VISUALIZATION_ROOT, { recursive: true });
    await execFileAsync("python3", ["-m", "venv", ANALYSIS_ENV], { timeout: 120000 });
  }
  const modules = ["numpy", "pandas", "matplotlib", "folium", "xyzservices", ...optionalDependencies];
  try {
    await execFileAsync(ANALYSIS_PYTHON, ["-c", `import ${modules.join(", ")}`], { timeout: 30000 });
  } catch {
    await execFileAsync(ANALYSIS_PYTHON, ["-m", "pip", "install", "-r", join(VISUALIZATION_ROOT, "requirements-core.txt"), ...optionalDependencies], {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  return ANALYSIS_PYTHON;
}

async function writeStudyDocuments(state: ConversationState) {
  const study = state.study;
  if (!study) return;
  const dataDirectory = join(study.bundlePath, "data");
  const figuresDirectory = join(study.bundlePath, "figures");
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(figuresDirectory, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    study: {
      id: study.id,
      title: study.title,
      context: study.context,
      scientificQuestion: study.scientificQuestion,
      phase: study.phase,
      createdAt: study.createdAt,
      visualizationVersion: study.visualizationVersion,
      updatedAt: state.updatedAt,
    },
    services: study.services,
    download: {
      confirmed: study.confirmed,
      budgetBytes: study.budgetBytes,
      downloadedBytes: study.downloadedBytes,
      remainingBytes: Math.max(0, study.budgetBytes - study.downloadedBytes),
    },
    artifacts: state.files,
  };
  await writeFile(join(study.bundlePath, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(study.bundlePath, "parameters.json"), JSON.stringify({ filters: state.filters, format: state.format }, null, 2));
  const provenanceRecords: unknown[] = [];
  for (const path of state.provenanceFiles) {
    try { provenanceRecords.push(JSON.parse(await readFile(path, "utf8"))); }
    catch { provenanceRecords.push({ provenanceFile: path, readable: false }); }
  }
  await writeFile(join(study.bundlePath, "provenance.json"), JSON.stringify({ records: provenanceRecords }, null, 2));
  const reproduce = study.visualizationVersion === 2
    ? "Run `analysis.py` through EPOS Agent. A notebook is generated only after the analysis succeeds."
    : `Run \`python3 analysis.py\` from this directory or open \`${study.slug}.ipynb\`.`;
  await writeFile(join(study.bundlePath, "README.md"), `# ${study.title}\n\n${study.context || "No context recorded."}\n\n## Scientific question\n\n${study.scientificQuestion || "Not yet defined."}\n\n## Reproduce\n\n${reproduce}\n\n## Completeness\n\nConsult \`manifest.json\` and \`provenance.json\` before scientific interpretation. Transport completeness does not by itself prove catalogue completeness.\n`);
  if (study.visualizationVersion === 2) await ensureVisualizationTemplate(study.bundlePath);
}

function jsonlRow(columns: unknown, row: unknown) {
  if (!Array.isArray(row) || !Array.isArray(columns)) return row;
  return Object.fromEntries(columns.map((column, index) => [String(column), row[index]]));
}

const FDSN_QUERY_ARGUMENTS = new Set([
  "starttime", "endtime", "updatedafter", "minmag", "maxmag", "minlat", "maxlat", "minlon", "maxlon",
  "mindepth", "maxdepth", "latitude", "longitude", "minradiuskm", "maxradiuskm", "limit", "offset", "orderby", "datacenter",
]);
const FDSN_ARGUMENT_ALIASES: Record<string, string> = {
  minmagnitude: "minmag", maxmagnitude: "maxmag", minlatitude: "minlat", maxlatitude: "maxlat",
  minlongitude: "minlon", maxlongitude: "maxlon",
};

function normalizeFdsnArguments(toolName: string, input: unknown) {
  const args = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  if (toolName === "fdsn_query_earthquakes") {
    for (const [alias, canonical] of Object.entries(FDSN_ARGUMENT_ALIASES)) {
      if (!(alias in args)) continue;
      if (canonical in args && args[canonical] !== args[alias]) throw new Error(`Conflicting FDSN parameters: ${alias} and ${canonical}`);
      args[canonical] = args[alias];
      delete args[alias];
    }
    const unknown = Object.keys(args).filter(key => !FDSN_QUERY_ARGUMENTS.has(key));
    if (unknown.length) throw new Error(`Unsupported FDSN query parameters: ${unknown.join(", ")}`);
    return args;
  }
  const unknown = Object.keys(args).filter(key => key !== "eventid" && key !== "datacenter");
  if (unknown.length) throw new Error(`Unsupported FDSN detail parameters: ${unknown.join(", ")}`);
  return args;
}

function createWorkflowTool() {
  const serviceShape = Type.Object({
    resourceId: Type.String({ description: "Authoritative service or dataset identifier" }),
    title: Type.String(),
    role: Type.String({ description: "Short scientific role shared in the grouped service summary" }),
    format: Type.Optional(Type.String()),
    estimatedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  });
  return defineTool({
    name: "epos_manage_study",
    label: "EPOS Manage Study",
    description: "Create and advance the general study workflow. Use start, prepare, confirm, complete or status; never expose internal service IDs in the chat summary.",
    parameters: Type.Object({
      action: StringEnum(["start", "prepare", "confirm", "complete", "status"] as const),
      title: Type.Optional(Type.String()),
      context: Type.Optional(Type.String()),
      scientificQuestion: Type.Optional(Type.String()),
      filters: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
      services: Type.Optional(Type.Array(serviceShape)),
    }),
    async execute(_id, params: any) {
      const action = params.action;
      if (action === "status") return modelResult({ state: runtimeConversationState, workspace: WORKSPACE });

      if (action === "start") {
        if (!params.title || typeof params.title !== "string") throw new Error("A study title is required.");
        const slug = safeName(params.title).slice(0, 80) || "study";
        const suffix = now().replace(/[:.]/g, "-");
        const bundlePath = join(WORKSPACE, `${slug}-${suffix}`);
        const study: StudyState = {
          id: `${slug}-${suffix}`,
          title: params.title.slice(0, 200),
          slug,
          bundlePath,
          context: String(params.context || "").slice(0, 4000),
          scientificQuestion: String(params.scientificQuestion || "").slice(0, 4000),
          phase: "context",
          services: [],
          confirmed: false,
          budgetBytes: MAX_DOWNLOAD_BYTES,
          downloadedBytes: 0,
          createdAt: now(),
          visualizationVersion: 2,
        };
        runtimeConversationState = {
          ...emptyConversationState(),
          intent: "manage_study",
          filters: pickStateFilters(params.filters || {}, Object.keys(params.filters || {}).slice(0, 30)),
          study,
          files: [
            join(bundlePath, "analysis.py"), join(bundlePath, "visualization.json"), join(bundlePath, "README.md"),
            join(bundlePath, "manifest.json"), join(bundlePath, "parameters.json"), join(bundlePath, "provenance.json"),
          ],
          updatedAt: now(),
        };
      } else {
        const study = runtimeConversationState.study;
        if (!study) throw new Error("Start a study before advancing its workflow.");
        if (action === "prepare") {
          const services = Array.isArray(params.services) ? params.services.slice(0, 100) : [];
          const knownTotal = services.reduce((sum: number, service: StudyService) => sum + (Number(service.estimatedBytes) || 0), 0);
          if (knownTotal + study.downloadedBytes > study.budgetBytes) throw new Error("The known download plan exceeds the remaining 1 GiB study budget; narrow the study before confirmation.");
          runtimeConversationState = {
            ...runtimeConversationState,
            filters: { ...runtimeConversationState.filters, ...pickStateFilters(params.filters || {}, Object.keys(params.filters || {}).slice(0, 30)) },
            study: {
              ...study,
              context: params.context === undefined ? study.context : String(params.context).slice(0, 4000),
              scientificQuestion: params.scientificQuestion === undefined ? study.scientificQuestion : String(params.scientificQuestion).slice(0, 4000),
              services,
              confirmed: false,
              phase: "services",
            },
            updatedAt: now(),
          };
        } else if (action === "confirm") {
          if (!study.services.length) throw new Error("Prepare at least one service before confirming the download plan.");
          runtimeConversationState = { ...runtimeConversationState, study: { ...study, confirmed: true, phase: "download" }, updatedAt: now() };
        } else if (action === "complete") {
          runtimeConversationState = { ...runtimeConversationState, study: { ...study, phase: "complete" }, updatedAt: now() };
        }
      }
      await writeStudyDocuments(runtimeConversationState);
      const result = { state: runtimeConversationState, workspace: runtimeConversationState.study?.bundlePath };
      const study = runtimeConversationState.study;
      return modelResult(result, {
        action,
        studyId: study?.id,
        phase: study?.phase,
        confirmed: study?.confirmed,
        serviceCount: study?.services.length,
        budgetBytes: study?.budgetBytes,
        downloadedBytes: study?.downloadedBytes,
        remainingBytes: study ? Math.max(0, study.budgetBytes - study.downloadedBytes) : undefined,
        workspace: study?.bundlePath,
      });
    },
  });
}

const searchTool = defineTool({
  name: "epos_search_resources",
  label: "EPOS Search Resources",
  description: "Search every EPOS catalogue page and return compact candidates for internal ranking. In chat show titles grouped by scientific role, without IDs or per-item rationales.",
  parameters: Type.Object({
    q: Type.Optional(Type.String({ description: "Free text, for example earthquake, GNSS or volcano" })),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    bbox: Type.Optional(Type.String()),
    keywords: Type.Optional(Type.String()),
    scienceDomains: Type.Optional(Type.String({ description: "Comma-separated EPOS science-domain names or codes; applied locally" })),
    serviceTypes: Type.Optional(Type.String()),
    organizations: Type.Optional(Type.String()),
    versioningStatus: Type.Optional(Type.String()),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Cards per page; default and maximum 5" })),
  }),
  async execute(_id, params: any) {
    const filters = { ...params };
    delete filters.offset;
    delete filters.limit;
    const resources: any[] = [];
    const endpoints: string[] = [];
    let offset = 0;
    let pageCount = 0;
    let totalResults = 0;
    let provenance: any = {};
    const visited = new Set<number>();
    while (!visited.has(offset)) {
      visited.add(offset);
      const page = await eposMcpCall("search_resources", { ...filters, offset, limit: 5 });
      pageCount += 1;
      totalResults = Number(page.totalResults) || totalResults;
      provenance = page.provenance || provenance;
      if (page.provenance?.endpoint) endpoints.push(page.provenance.endpoint);
      for (const resource of page.resources || []) {
        if (!resources.some(existing => existing.id === resource.id)) {
          resources.push({ id: resource.id, title: resource.title, domains: resource.domains });
        }
      }
      if (!page.hasMore || !Number.isInteger(page.nextOffset)) break;
      offset = page.nextOffset;
      if (pageCount >= 200) throw new Error("EPOS catalogue pagination exceeded 200 pages.");
    }
    return resultWithProvenance("search", params, {
      totalResults,
      returnedResults: resources.length,
      pageCount,
      searchedAllPages: resources.length >= totalResults,
      resources,
      endpoints,
      provenance,
    });
  },
});

const organizationSearchTool = defineTool({
  name: "epos_search_organizations",
  label: "EPOS Search Organizations",
  description: "Resolve an EPOS provider name to organization IDs. Returns up to five compact candidates.",
  parameters: Type.Object({
    q: Type.String({ description: "Provider or organization name, for example INGV" }),
    country: Type.Optional(Type.String({ description: "Optional country name or code" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Candidates per page; default and maximum 5" })),
  }),
  async execute(_id, params: any) {
    return resultWithProvenance("organization-search", params, await eposMcpCall("search_organizations", params));
  },
});

const softwareSearchTool = defineTool({
  name: "epos_search_software",
  label: "EPOS Search Software",
  description: "Search the EPOS software catalogue. Returns compact cards with pagination.",
  parameters: Type.Object({
    q: Type.Optional(Type.String({ description: "Software name, description or keyword" })),
    versioningStatus: Type.Optional(Type.String({ description: "Optional EPOS versioning status filter" })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Cards per page; default and maximum 5" })),
  }),
  async execute(_id, params: any) {
    const filters = { ...params };
    delete filters.offset;
    delete filters.limit;
    const software: any[] = [];
    let offset = 0;
    let pageCount = 0;
    let totalResults = 0;
    let provenance: any = {};
    while (true) {
      const page = await eposMcpCall("search_software", { ...filters, offset, limit: 5 });
      pageCount += 1;
      totalResults = Number(page.totalResults) || totalResults;
      provenance = page.provenance || provenance;
      for (const item of page.software || []) if (!software.some(existing => existing.id === item.id)) software.push(item);
      if (!page.hasMore || !Number.isInteger(page.nextOffset)) break;
      offset = page.nextOffset;
      if (pageCount >= 200) throw new Error("EPOS software pagination exceeded 200 pages.");
    }
    return resultWithProvenance("software-search", params, { totalResults, returnedResults: software.length, pageCount, searchedAllPages: software.length >= totalResults, software, provenance });
  },
});

const describeResourceTool = defineTool({
  name: "epos_describe_resource",
  label: "EPOS Describe Resource",
  description: "Describe one EPOS resource using compact authoritative metadata.",
  parameters: Type.Object({ resourceId: Type.String({ description: "EPOS distribution/resource instance id" }) }),
  async execute(_id, params: any) {
    return resultWithProvenance("describe-resource", params, await eposMcpCall("describe_resource", params));
  },
});

const describeSoftwareTool = defineTool({
  name: "epos_describe_software",
  label: "EPOS Describe Software",
  description: "Describe one EPOS software record using compact authoritative metadata.",
  parameters: Type.Object({ softwareId: Type.String({ description: "EPOS software instance id" }) }),
  async execute(_id, params: any) {
    return resultWithProvenance("describe-software", params, await eposMcpCall("describe_software", params));
  },
});

const describeServiceTool = defineTool({
  name: "epos_describe_service",
  label: "EPOS Describe Service",
  description: "Return one EPOS service endpoint and its normalized executable parameters.",
  parameters: Type.Object({ resourceId: Type.String({ description: "EPOS distribution/resource instance id" }) }),
  async execute(_id, params: any) {
    return resultWithProvenance("describe-service", params, await eposMcpCall("describe_service", params));
  },
});

const executeTool = defineTool({
  name: "epos_execute_service",
  label: "EPOS Execute Service",
  description: "Execute an EPOS service inside the active study bundle. Reports transport and scientific completeness separately; the study has a cumulative 1 GiB download budget.",
  parameters: Type.Object({
    resourceId: Type.String({ description: "EPOS distribution/resource instance id to execute" }),
    format: Type.Optional(Type.String({ description: "Requested output format from availableFormats" })),
    inputFormat: Type.Optional(Type.String({ description: "Plugin input format if using a converted format" })),
    pluginId: Type.Optional(Type.String({ description: "Plugin id if using converted output" })),
    useDefaults: Type.Optional(Type.Boolean({ description: "Let EPOS gateway use default values" })),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    bbox: Type.Optional(Type.String()),
    serviceParameters: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Advertised service parameter name/value map, encoded into EPOS params JSON" })),
    previewBytes: Type.Optional(Type.Number({ description: "Chat preview bytes; default 4000, maximum 12000" })),
    estimateOnly: Type.Optional(Type.Boolean({ description: "Estimate response size without downloading data" })),
    allowLargeDownload: Type.Optional(Type.Boolean({ description: "Deprecated compatibility parameter; the study uses one plan confirmation and a cumulative 1 GiB budget" })),
    outputFileName: Type.Optional(Type.String({ description: "Optional filename for saving the downloaded response inside the EPOS workspace" })),
  }),
  async execute(_id, params: any) {
    if (!params.estimateOnly) requireConfirmedStudy();
    const remainingBytes = remainingStudyBudget();
    if (!params.estimateOnly && remainingBytes <= 0) throw new Error("The active study has exhausted its 1 GiB download budget.");
    const study = runtimeConversationState.study;
    const callParams = {
      ...params,
      maxDownloadBytes: remainingBytes,
      outputDirectory: study ? relative(WORKSPACE, join(study.bundlePath, "data")) : undefined,
    };
    const action = params.estimateOnly ? "estimate-service" : "execute-service";
    return resultWithProvenance(action, params, await eposMcpCall("execute_service", callParams));
  },
});

async function executeEposProxy(toolName: string, args: any, metadataOnly: boolean = false) {
  if (toolName === "epos_execute" || (toolName === "epos_fetch" && !metadataOnly)) requireConfirmedStudy();
  const result = await eposMcpCall(toolName, args);
  if (toolName === "epos_execute" && typeof result?.artifact_path === "string") {
    const source = resolve(result.artifact_path);
    if (source !== EPOS_MCP_ARTIFACTS && !source.startsWith(EPOS_MCP_ARTIFACTS + sep)) {
      throw new Error("EPOS MCP returned an artifact outside its local artifact directory.");
    }
    const info = await stat(source);
    if (info.size > remainingStudyBudget()) throw new Error("EPOS response exceeds the remaining study download budget.");
    const outputDirectory = activeStudyDataDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const outputFile = join(outputDirectory, `epos-${Date.now()}${extname(source) || ".bin"}`);
    await copyFile(source, outputFile);
    result.outputFile = outputFile;
    result.bytes = info.size;
  }
  return resultWithProvenance(`mcp-${toolName}`, args, { tool: toolName, ...result });
}

const nativeEposSearchTool = defineTool({
  name: "epos_search",
  label: "EPOS Search",
  description: "Search EPOS distributions.",
  parameters: Type.Object({
    q: Type.Optional(Type.String({ description: "Free-text query" })),
    keywords: Type.Optional(Type.String({ description: "Comma-separated keywords" })),
    organisations: Type.Optional(Type.String({ description: "Organization ID" })),
    sciencedomains: Type.Optional(Type.String({ description: "Science domain filter" })),
    servicetypes: Type.Optional(Type.String({ description: "Service type filter (WMS, WFS, WCS)" })),
    startDate: Type.Optional(Type.String({ description: "Start date ISO" })),
    endDate: Type.Optional(Type.String({ description: "End date ISO" })),
    bbox: Type.Optional(Type.String({ description: "Bounding box: west,south,east,north" })),
    facetstype: Type.Optional(Type.String({ description: "categories, dataproviders, serviceproviders" })),
    facets: Type.Optional(Type.String({ description: "true or false" })),
    limit: Type.Optional(Type.Integer({ description: "Number of results per page" }))
  }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_search", args); }
});

const nativeEposSearchPageTool = defineTool({
  name: "epos_search_page",
  label: "EPOS Search Page",
  description: "Get a specific page of search results.",
  parameters: Type.Object({
    search_id: Type.String(), offset: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer())
  }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_search_page", args); }
});

const nativeEposSelectCandidateTool = defineTool({
  name: "epos_select_candidate",
  label: "EPOS Select Candidate",
  description: "Mark a distribution ID as a candidate for current study requirements.",
  parameters: Type.Object({ distribution_id: Type.String() }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_select_candidate", args); }
});

const nativeEposSearchFilterTool = defineTool({
  name: "epos_search_filter",
  label: "EPOS Search Filter",
  description: "Filter search results.",
  parameters: Type.Object({
    search_id: Type.String(), index: Type.Integer()
  }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_search_filter", args); }
});

const nativeEposOrganizationsTool = defineTool({
  name: "epos_organizations",
  label: "EPOS Organizations",
  description: "Search EPOS organizations.",
  parameters: Type.Object({
    q: Type.Optional(Type.String()), country: Type.Optional(Type.String()), org_type: Type.Optional(Type.String())
  }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_organizations", args); }
});

const nativeEposDetailsTool = defineTool({
  name: "epos_details",
  label: "EPOS Details",
  description: "Get details for an EPOS distribution.",
  parameters: Type.Object({ distribution_id: Type.String() }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_details", args); }
});

const nativeEposPrepareExecuteTool = defineTool({
  name: "epos_prepare_execute",
  label: "EPOS Prepare Execute",
  description: "Prepare to execute an EPOS service.",
  parameters: Type.Object({
    distribution_id: Type.String(), format: Type.Optional(Type.String()), startDate: Type.Optional(Type.String()), endDate: Type.Optional(Type.String()), bbox: Type.Optional(Type.String()), useDefaults: Type.Optional(Type.String()), pluginId: Type.Optional(Type.String()), inputFormat: Type.Optional(Type.String())
  }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_prepare_execute", args); }
});

const nativeEposExecuteTool = defineTool({
  name: "epos_execute",
  label: "EPOS Execute",
  description: "Execute an EPOS service.",
  parameters: Type.Object({ distribution_id: Type.String(), request_payload: Type.Any() }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_execute", args); }
});

const nativeEposInspectTool = defineTool({
  name: "epos_inspect",
  label: "EPOS Inspect",
  description: "Inspect EPOS service results.",
  parameters: Type.Object({ execution_id: Type.String() }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_inspect", args); }
});

const nativeEposVisualizeTool = defineTool({
  name: "epos_visualize",
  label: "EPOS Visualize",
  description: "Visualize EPOS service results.",
  parameters: Type.Object({ execution_id: Type.String() }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_visualize", args); }
});

const nativeEposFetchTool = defineTool({
  name: "epos_fetch",
  label: "EPOS Fetch",
  description: "Fetch EPOS service results.",
  parameters: Type.Object({ url: Type.String(), metadataOnly: Type.Optional(Type.Boolean()) }),
  async execute(_id: string, args: any) { return executeEposProxy("epos_fetch", args, args.metadataOnly); }
});

const visualizationDatasetShape = Type.Object({
  path: Type.String({ description: "Dataset path inside the active study bundle" }),
  label: Type.Optional(Type.String()),
  role: Type.Optional(StringEnum(["events", "stations", "vector_overlay", "raster", "waveforms"] as const)),
  crs: Type.Optional(Type.String({ description: "Declared source CRS when it is not embedded in the data" })),
  mapping: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional field overrides such as latitude, longitude, time, value, values, x and y" })),
  units: Type.Optional(Type.Record(Type.String(), Type.String())),
  plots: Type.Optional(Type.Array(StringEnum(["distribution", "scatter", "time_series", "gutenberg_richter", "space_time", "vertical_section", "beachballs"] as const))),
});

const visualizationRecipeShape = Type.Object({
  name: StringEnum(["seismic_catalog_standard", "seismic_sequence", "focal_mechanism_standard", "hazard_map_standard", "custom"] as const),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const visualizationWmsShape = Type.Object({
  url: Type.String(),
  layers: Type.String(),
  attribution: Type.String(),
  name: Type.Optional(Type.String()),
  format: Type.Optional(Type.String()),
});

const prepareVisualizationTool = defineTool({
  name: "epos_prepare_visualization",
  label: "EPOS Prepare Visualization",
  description: "Prepare the v2 recipe selected from the researcher's request for downloaded study data. Declare dataset roles and only genuine field or CRS overrides.",
  parameters: Type.Object({
    recipe: visualizationRecipeShape,
    datasets: Type.Optional(Type.Array(visualizationDatasetShape)),
    basemap: Type.Optional(StringEnum(["street", "satellite", "none"] as const)),
    topography: Type.Optional(Type.Boolean({ description: "Render a PyGMT topographic map when GMT is available, otherwise record a fallback" })),
    extent: Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4, description: "Confirmed or authoritative [west, south, east, north] map extent" })),
    interactive: Type.Optional(Type.Boolean({ description: "Create interactive HTML outputs only after the researcher confirms the offer made after reviewing PNG outputs" })),
    wms: Type.Optional(Type.Array(visualizationWmsShape)),
  }),
  async execute(_id, params: any) {
    const study = runtimeConversationState.study;
    if (!study) throw new Error("Start a study before preparing a visualization.");
    if (study.visualizationVersion !== 2) throw new Error("Visualization v2 applies only to newly created studies; recreate earlier test studies.");
    if (!["download", "code", "visualization"].includes(study.phase)) {
      throw new Error("Download study data before preparing a visualization.");
    }
    await ensureVisualizationTemplate(study.bundlePath);
    const datasets = Array.isArray(params.datasets) ? params.datasets.map((item: any) => {
      const path = resolveWorkspacePath(item.path, study.bundlePath);
      if (path !== study.bundlePath && !path.startsWith(study.bundlePath + sep)) {
        throw new Error(`Visualization dataset must be inside ${study.bundlePath}`);
      }
      return { ...item, path: relative(study.bundlePath, path) };
    }) : [];
    const basemap = ["street", "satellite", "none"].includes(params.basemap) ? params.basemap : "satellite";
    const topography = params.topography === true;
    const interactive = params.interactive === true;
    const extent = Array.isArray(params.extent) && params.extent.length === 4 ? params.extent : undefined;
    const config = { version: 2, recipe: params.recipe, datasets, map: { basemap, topography, ...(extent ? { extent } : {}) }, interactive, wms: Array.isArray(params.wms) ? params.wms : [] };
    const configPath = join(study.bundlePath, "visualization.json");
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const detectedFiles = await visualizationDataFiles(join(study.bundlePath, "data"));
    const configuredFiles = datasets.map((item: any) => join(study.bundlePath, item.path));
    const allFiles = [...detectedFiles, ...configuredFiles];
    const extensions = new Set(allFiles.map(path => extname(path).toLowerCase()));
    const gmtAvailable = topography && await execFileAsync("gmt", ["--version"], { timeout: 5000 }).then(() => true).catch(() => false);
    const optionalDependencies = [
      ...(basemap === "satellite" ? ["contextily", "rasterio", "pyproj"] : []),
      ...([".tif", ".tiff"].some(extension => extensions.has(extension)) ? ["rasterio"] : []),
      ...([".xml", ".qml", ".mseed", ".msd", ".seed"].some(extension => extensions.has(extension)) ? ["obspy"] : []),
      ...(extensions.has(".parquet") ? ["pyarrow"] : []),
      ...([".gpkg", ".shp"].some(extension => extensions.has(extension)) ? ["geopandas"] : []),
      ...(datasets.some((item: any) => item.crs && String(item.crs).toUpperCase() !== "EPSG:4326") ? ["pyproj"] : []),
      ...(interactive ? ["plotly"] : []),
      ...(gmtAvailable ? ["pygmt"] : []),
    ];
    await ensureAnalysisEnvironment([...new Set(optionalDependencies)]);
    return modelResult({
      analysisPath: join(study.bundlePath, "analysis.py"),
      configPath,
      detectedFiles,
      basemap,
      topographyBackend: gmtAvailable ? "pygmt" : "coordinate-grid fallback",
      optionalDependencies,
    }, {
      prepared: true,
      analysisPath: join(study.bundlePath, "analysis.py"),
      configPath,
      datasetCount: datasets.length || detectedFiles.length,
      autoDiscovery: datasets.length === 0,
      basemap,
      topographyBackend: gmtAvailable ? "pygmt" : "coordinate-grid fallback",
    });
  },
});

const finalizeNotebookTool = defineTool({
  name: "epos_finalize_notebook",
  label: "EPOS Finalize Notebook",
  description: "Create the study notebook and complete requirements only after analysis.py has run successfully.",
  parameters: Type.Object({}),
  async execute() {
    const study = runtimeConversationState.study;
    if (!study) throw new Error("Start a study before finalizing a notebook.");
    if (study.visualizationVersion !== 2) throw new Error("Notebook finalization applies only to visualization v2 studies.");
    const reportPath = join(study.bundlePath, "analysis-report.json");
    try { await access(reportPath); }
    catch { throw new Error("Run analysis.py successfully before finalizing the notebook."); }
    const python = await ensureAnalysisEnvironment();
    await execFileAsync(python, [join(VISUALIZATION_ROOT, "sync_requirements.py"), study.bundlePath], {
      cwd: study.bundlePath,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    const requirementsPath = join(study.bundlePath, "requirements.txt");
    const notebookPath = join(study.bundlePath, `${study.slug}.ipynb`);
    const notebook = {
      cells: [
        { id: "install-dependencies", cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["%pip install -r requirements.txt\n"] },
        { id: "study-context", cell_type: "markdown", metadata: {}, source: [`# ${study.title}\n`, `${study.scientificQuestion || "Scientific question not yet defined."}\n`] },
        { id: "run-analysis", cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["from analysis import main\n", "report = main()\n", "report\n"] },
        { id: "display-outputs", cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [
          "from pathlib import Path\n",
          "from IPython.display import Image, Markdown, display\n",
          "for output in report['outputs']:\n",
          "    path = Path(output)\n",
          "    link = path.relative_to(Path.cwd()) if path.is_relative_to(Path.cwd()) else path\n",
          "    display(Image(filename=str(path))) if path.suffix.lower() == '.png' else display(Markdown(f'[{path.name}]({link.as_posix()})'))\n",
        ] },
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python", version: "3" } },
      nbformat: 4,
      nbformat_minor: 5,
    };
    await writeFile(notebookPath, JSON.stringify(notebook, null, 2) + "\n");
    return modelResult({ notebookPath, requirementsPath, reportPath }, { finalized: true, notebookPath, requirementsPath });
  },
});

const runPythonTool = defineTool({
  name: "epos_run_python",
  label: "EPOS Run Python",
  description: "Run Python only inside the active study bundle (or the EPOS workspace when no study is active). Temporary generated scripts are removed after execution.",
  parameters: Type.Object({
    code: Type.Optional(Type.String({ description: "Python source to write to a temporary script in the EPOS workspace and run" })),
    scriptPath: Type.Optional(Type.String({ description: "Existing .py script path; must be inside ~/epos-agent/workspace" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Execution timeout in ms; default 60000, max 300000" })),
    outputImagePath: Type.Optional(Type.String({ description: "Optional PNG/JPEG/GIF/WebP path inside workspace to return inline after execution" })),
  }),
  async execute(_id, params: any, signal) {
    const executionDirectory = runtimeConversationState.study?.bundlePath || WORKSPACE;
    await mkdir(executionDirectory, { recursive: true });
    let script: string;
    let temporaryScript = false;
    if (params.code) {
      script = join(executionDirectory, `.epos-run-${Date.now()}.py`);
      await writeFile(script, params.code);
      temporaryScript = true;
    } else if (params.scriptPath) {
      script = resolveWorkspacePath(params.scriptPath, executionDirectory);
    } else {
      throw new Error("Provide either code or scriptPath");
    }
    const timeout = Math.max(1000, Math.min(Number(params.timeoutMs || 60000), 300000));
    const args = Array.isArray(params.args) ? params.args : [];
    const expectedReportPath = !temporaryScript && resolve(script) === join(executionDirectory, "analysis.py")
      ? join(executionDirectory, "analysis-report.json")
      : undefined;
    if (expectedReportPath) await unlink(expectedReportPath).catch(() => {});
    let stdout = "";
    let stderr = "";
    const python = await analysisPython();
    try {
      ({ stdout, stderr } = await execFileAsync(python, [script, ...args], {
        cwd: executionDirectory,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, MPLBACKEND: "Agg", EPOS_AGENT_ROOT: ROOT, EPOS_WORKSPACE: executionDirectory },
        signal,
      }));
    } finally {
      if (temporaryScript) await unlink(script).catch(() => {});
    }
    let outputs: string[] = [];
    let reportPath: string | undefined;
    if (expectedReportPath) {
      try {
        reportPath = expectedReportPath;
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        outputs = Array.isArray(report.outputs) ? report.outputs.filter((path: unknown): path is string => typeof path === "string") : [];
      } catch { reportPath = undefined; }
    }
    const record = { action: "run-python", timestamp: now(), workspace: executionDirectory, script: temporaryScript ? undefined : script, generatedCode: temporaryScript, args, timeoutMs: timeout, stdoutBytes: stdout.length, stderrBytes: stderr.length, outputImagePath: params.outputImagePath, reportPath, outputs };
    const provenanceFile = await logProvenance(record);
    const fullResult = { provenance: { ...record, provenanceFile }, stdout, stderr, reportPath, outputs };
    const serialized = JSON.stringify(fullResult);
    let outputLog: string | undefined;
    let chatResult: unknown = fullResult;
    if (serialized.length > MODEL_RESULT_LIMIT) {
      outputLog = join(executionDirectory, `epos-python-output-${Date.now()}.json`);
      await writeFile(outputLog, serialized);
      chatResult = { provenance: fullResult.provenance, outputLog, stdoutPreview: stdout.slice(0, 4000), stderrPreview: stderr.slice(0, 2000) };
    }
    const content: any[] = [...modelResult(chatResult).content];
    if (params.outputImagePath) {
      content.push(await imageBlock(resolveWorkspacePath(params.outputImagePath, executionDirectory)));
    }
    return { content, details: { ...fullResult, outputLog } };
  },
});

const showImageTool = defineTool({
  name: "epos_show_image",
  label: "EPOS Show Image",
  description: "Display an existing PNG/JPEG/GIF/WebP image from ~/epos-agent/workspace inline in the Pi TUI/chat.",
  parameters: Type.Object({ path: Type.String({ description: "Image path inside ~/epos-agent/workspace" }) }),
  async execute(_id, params: any) {
    const abs = resolveWorkspacePath(params.path, runtimeConversationState.study?.bundlePath || WORKSPACE);
    return { content: [{ type: "text", text: `Displaying image: ${abs}` }, await imageBlock(abs)], details: { path: abs, mimeType: imageMime(abs) } };
  },
});

const fdsnMcpTool = defineTool({
  name: "epos_fdsnws_event_call",
  label: "EPOS FDSNWS Event MCP Call",
  description: "Query FDSN earthquake data. Without an explicit limit, partitions long time spans into month-sized shards, subdivides dense shards to avoid provider result caps, deduplicates events and verifies boundary coverage. With a limit, requests exactly that subset.",
  parameters: Type.Object({
    toolName: StringEnum(["fdsn_query_earthquakes", "fdsn_get_earthquake_by_id", "fdsn_get_arrivals_by_id", "fdsn_get_allmagnitudes_by_id", "fdsn_get_allorigins_by_id", "fdsn_get_focalmechanism_by_id"] as const),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments for the selected MCP tool. Query names: starttime, endtime, minmag, maxmag, minlat, maxlat, minlon, maxlon, mindepth, maxdepth, latitude, longitude, minradiuskm, maxradiuskm, updatedafter, limit, offset, orderby, datacenter. Detail tools accept eventid and datacenter." })),
    allowLargeDownload: Type.Optional(Type.Boolean({ description: "Deprecated compatibility parameter; the active study uses one confirmation and a cumulative 1 GiB budget" })),
  }),
  async execute(_id, params: any, signal) {
    const allowed = new Set(["fdsn_query_earthquakes", "fdsn_get_earthquake_by_id", "fdsn_get_arrivals_by_id", "fdsn_get_allmagnitudes_by_id", "fdsn_get_allorigins_by_id", "fdsn_get_focalmechanism_by_id"]);
    if (!allowed.has(params.toolName)) throw new Error(`Unsupported mcp-fdsnws-event tool: ${params.toolName}`);
    await mcp.start();
    const originalArguments = normalizeFdsnArguments(params.toolName, params.arguments);
    params.arguments = originalArguments;

    if (params.toolName !== "fdsn_query_earthquakes") {
      const result = await mcp.request("tools/call", { name: params.toolName, arguments: originalArguments });
      const payload = parseMcpPayload(result);
      const serialized = JSON.stringify(payload);
      const serializedBytes = Buffer.byteLength(serialized);
      let outputFile: string | undefined;
      if (serialized.length > MODEL_RESULT_LIMIT) {
        requireConfirmedStudy();
        const outputDirectory = activeStudyDataDirectory();
        if (serializedBytes > remainingStudyBudget()) throw new Error("FDSN detail response exceeds the remaining study download budget");
        await mkdir(outputDirectory, { recursive: true });
        outputFile = join(outputDirectory, `fdsn-${safeName(params.toolName)}-${Date.now()}.json`);
        await writeFile(outputFile, serialized);
      }
      return resultWithProvenance("fdsnws-event-mcp", originalArguments, {
        toolName: params.toolName,
        outputFile,
        bytes: outputFile ? serializedBytes : 0,
        result: outputFile ? { savedInFull: true, preview: serialized.slice(0, MODEL_RESULT_LIMIT) } : payload,
      });
    }

    requireConfirmedStudy();
    const outputDirectory = activeStudyDataDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const datacenter = safeName(originalArguments.datacenter || "INGV");
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const outputFile = join(outputDirectory, `fdsn-events-${datacenter}-${suffix}.jsonl`);
    const partialFile = outputFile.replace(/\.jsonl$/, ".partial.jsonl");
    const file = await open(outputFile, "w");
    const explicitLimit = Object.prototype.hasOwnProperty.call(originalArguments, "limit");
    const requestedLimit = explicitLimit ? Number(originalArguments.limit) : undefined;
    let recordCount = 0;
    let bytes = 0;
    let pageCount = 0;
    let shardCount = 0;
    let splitCount = 0;
    let columns: unknown[] = [];
    const sample: unknown[] = [];
    const endpoints = new Set<string>();
    const eventIds = new Set<string>();
    let firstEventTime: string | undefined;
    let lastEventTime: string | undefined;
    const remainingBudget = remainingStudyBudget();

    const callPage = async (pageArguments: Record<string, unknown>) => {
      if (signal?.aborted) throw new Error("FDSN download aborted");
      const result = await mcp.request("tools/call", { name: params.toolName, arguments: pageArguments });
      const page = parseMcpPayload(result);
      if (page?.error) throw new Error(JSON.stringify(page));
      pageCount += 1;
      if (page.api_url) endpoints.add(page.api_url);
      if (Array.isArray(page.columns) && page.columns.length) columns = page.columns;
      return page;
    };

    const rowKey = (rowColumns: unknown[], row: unknown) => {
      const idIndex = rowColumns.findIndex(column => String(column).toLowerCase() === "eventid");
      if (Array.isArray(row) && idIndex >= 0 && row[idIndex] !== undefined) return `${datacenter}:${String(row[idIndex])}`;
      return `${datacenter}:${JSON.stringify(row)}`;
    };

    const writeRows = async (rowColumns: unknown[], rows: unknown[]) => {
      const timeIndex = rowColumns.findIndex(column => String(column).toLowerCase() === "time");
      for (const row of rows) {
        const key = rowKey(rowColumns, row);
        if (eventIds.has(key)) continue;
        const event = jsonlRow(rowColumns, row);
        const line = JSON.stringify(event) + "\n";
        const lineBytes = Buffer.byteLength(line);
        if (bytes + lineBytes > remainingBudget) throw new Error("FDSN dataset exceeds the remaining study download budget");
        await file.write(line);
        eventIds.add(key);
        bytes += lineBytes;
        recordCount += 1;
        if (sample.length < FDSN_SAMPLE_SIZE) sample.push(event);
        if (Array.isArray(row) && timeIndex >= 0 && row[timeIndex] !== undefined) {
          const eventTime = String(row[timeIndex]);
          if (!firstEventTime || eventTime < firstEventTime) firstEventTime = eventTime;
          if (!lastEventTime || eventTime > lastEventTime) lastEventTime = eventTime;
        }
      }
    };

    try {
      let datasetCompleteness: "verified" | "requested_subset" = explicitLimit ? "requested_subset" : "verified";
      let requestedStart: string | undefined;
      let requestedEnd: string | undefined;
      if (explicitLimit) {
        const page = await callPage(originalArguments);
        await writeRows(Array.isArray(page.columns) ? page.columns : columns, Array.isArray(page.rows) ? page.rows : []);
        shardCount = 1;
      } else {
        const today = new Date().toISOString().slice(0, 10);
        requestedStart = String(originalArguments.starttime || `${today}T00:00:00`);
        requestedEnd = String(originalArguments.endtime || `${today}T23:59:59`);
        const startMs = Date.parse(requestedStart);
        const endMs = Date.parse(requestedEnd);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) throw new Error("FDSN complete downloads require a valid chronological starttime/endtime interval");
        const baseArguments = { ...originalArguments };
        delete baseArguments.starttime;
        delete baseArguments.endtime;
        delete baseArguments.limit;
        delete baseArguments.offset;
        delete baseArguments.orderby;

        const fetchInterval = async (intervalStart: string, intervalEnd: string, depth = 0): Promise<void> => {
          const left = Date.parse(intervalStart);
          const right = Date.parse(intervalEnd);
          if (right - left > FDSN_INITIAL_SHARD_MS) {
            const shardEnd = new Date(left + FDSN_INITIAL_SHARD_MS).toISOString();
            splitCount += 1;
            await fetchInterval(intervalStart, shardEnd, depth);
            await fetchInterval(shardEnd, intervalEnd, depth);
            return;
          }
          const page = await callPage({
            ...baseArguments,
            starttime: intervalStart,
            endtime: intervalEnd,
            limit: FDSN_PAGE_SIZE,
            offset: 1,
            orderby: "time-asc",
          });
          const rowColumns = Array.isArray(page.columns) ? page.columns : columns;
          const rows = Array.isArray(page.rows) ? page.rows : [];
          let advancedByTime = false;
          if (rows.length >= FDSN_PAGE_SIZE) {
            const timeIndex = rowColumns.findIndex(column => String(column).toLowerCase() === "time");
            if (timeIndex >= 0) {
              const firstRowTime = String(rows[0][timeIndex]);
              const lastRowTime = String(rows[rows.length - 1][timeIndex]);
              if (firstRowTime < lastRowTime && lastRowTime > intervalStart && lastRowTime < intervalEnd) {
                shardCount += 1;
                await writeRows(rowColumns, rows);
                await fetchInterval(lastRowTime, intervalEnd, depth + 1);
                advancedByTime = true;
              } else if (firstRowTime > lastRowTime && lastRowTime < intervalEnd && lastRowTime > intervalStart) {
                shardCount += 1;
                await writeRows(rowColumns, rows);
                await fetchInterval(intervalStart, lastRowTime, depth + 1);
                advancedByTime = true;
              }
            }
          }
          if (!advancedByTime) {
            if (rows.length >= FDSN_PAGE_SIZE) {
              if (depth >= 48 || right - left <= 1) throw new Error(`FDSN coverage cannot be proven for dense interval ${intervalStart} to ${intervalEnd}`);
              const midpoint = new Date(left + Math.floor((right - left) / 2)).toISOString();
              splitCount += 1;
              await fetchInterval(intervalStart, midpoint, depth + 1);
              await fetchInterval(midpoint, intervalEnd, depth + 1);
              return;
            }
            shardCount += 1;
            await writeRows(rowColumns, rows);
          }
        };

        await fetchInterval(requestedStart, requestedEnd);

        const oldest = await callPage({ ...baseArguments, starttime: requestedStart, endtime: requestedEnd, limit: 1, offset: 1, orderby: "time-asc" });
        const newest = await callPage({ ...baseArguments, starttime: requestedStart, endtime: requestedEnd, limit: 1, offset: 1, orderby: "time" });
        const boundaryRows = [oldest, newest].flatMap(page => Array.isArray(page.rows) ? page.rows.map((row: unknown) => ({ columns: page.columns || columns, row })) : []);
        for (const boundary of boundaryRows) {
          if (!eventIds.has(rowKey(boundary.columns, boundary.row))) throw new Error("FDSN boundary verification failed; the dataset cannot be declared complete");
        }
      }
      await file.close();
      const coverage = {
        requestedStart,
        requestedEnd,
        firstEventTime,
        lastEventTime,
        boundariesVerified: !explicitLimit,
      };
      const record = {
        action: "fdsn-query",
        timestamp: now(),
        mcpServer: "mcp-fdsnws-event",
        parameters: originalArguments,
        datacenter,
        endpoints: [...endpoints],
        requestedLimit,
        recordCount,
        pageCount,
        shardCount,
        splitCount,
        bytes,
        outputFile,
        complete: true,
        datasetCompleteness,
        coverage,
      };
      const provenanceFile = await logProvenance(record);
      return modelResult({ recordCount, pageCount, shardCount, splitCount, bytes, outputFile, complete: true, datasetCompleteness, coverage, sample, provenance: { ...record, provenanceFile } });
    } catch (error) {
      await file.close().catch(() => {});
      let retainedFile: string | undefined;
      if (recordCount > 0) {
        await rename(outputFile, partialFile);
        retainedFile = partialFile;
      } else {
        await unlink(outputFile).catch(() => {});
      }
      const record = {
        action: "fdsn-query",
        timestamp: now(),
        mcpServer: "mcp-fdsnws-event",
        parameters: originalArguments,
        datacenter,
        endpoints: [...endpoints],
        requestedLimit,
        recordCount,
        pageCount,
        shardCount,
        splitCount,
        bytes,
        outputFile: retainedFile,
        complete: false,
        datasetCompleteness: "partial",
        coverage: { firstEventTime, lastEventTime, boundariesVerified: false },
        error: error instanceof Error ? error.message : String(error),
      };
      const provenanceFile = await logProvenance(record);
      throw new Error(JSON.stringify({ code: "FDSN_PARTIAL_DOWNLOAD", complete: false, datasetCompleteness: "partial", recordCount, pageCount, shardCount, splitCount, bytes, outputFile: retainedFile, provenanceFile, coverage: record.coverage, error: record.error }));
    }
  },
});

const BASE_TOOLS = ["read", "epos_load_tools"];
const TOOL_GROUPS: Record<string, string[]> = {
  workflow: ["epos_manage_study"],
  catalog_search: ["epos_search", "epos_search_page", "epos_search_filter", "epos_organizations"],
  description: ["epos_details", "epos_select_candidate", "epos_inspect", "epos_visualize"],
  download: ["epos_prepare_execute", "epos_execute", "epos_fetch"],
  seismology: ["epos_fdsnws_event_call"],
  analysis: ["read", "epos_prepare_visualization", "epos_run_python", "epos_finalize_notebook", "epos_show_image"],
  workspace: ["read", "write", "edit", "ls", "find", "grep"],
};

function availableToolNames(pi: ExtensionAPI) {
  return new Set(pi.getAllTools().map(tool => tool.name));
}
function resetTools(pi: ExtensionAPI) {
  const available = availableToolNames(pi);
  pi.setActiveTools(BASE_TOOLS.filter(name => available.has(name)));
}

function createLoadToolsTool(pi: ExtensionAPI) {
  return defineTool({
    name: "epos_load_tools",
    label: "EPOS Load Tools",
    description: "Internal intent router. Call it autonomously to load only the capability required by the request; never ask the user to call it.",
    parameters: Type.Object({
      capability: StringEnum(["workflow", "catalog_search", "description", "download", "seismology", "analysis", "workspace"] as const),
    }),
    async execute(_id, params: any) {
      const available = availableToolNames(pi);
      const requested = TOOL_GROUPS[params.capability] || [];
      const activeTools = [...new Set([...BASE_TOOLS, ...requested])].filter(name => available.has(name));
      pi.setActiveTools(activeTools);
      return modelResult({ capability: params.capability, activeTools }, { capability: params.capability, loaded: true });
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Do not keep the large logo as a persistent widget: it crowds the editor area.
    // The full ASCII-art logo is printed once by the launcher before Pi starts.
    ctx.ui.setTitle("EPOS Agent");
    ctx.ui.setWorkingIndicator({ frames: ["🌍", "🌎", "🌏"], intervalMs: 180 });
    ctx.ui.setStatus("epos", "EPOS Agent");
    ctx.ui.setStatus("epos-api-mcp", "EPOS MCP starting");
    ctx.ui.setStatus("epos-fdsn", "FDSN MCP on demand");
    runtimeConversationState = restoreConversationState(ctx);
    await eposMcp.start();
    ctx.ui.setStatus("epos-api-mcp", "EPOS MCP ready");
    resetTools(pi);
  });
  pi.on("session_tree", async (_event, ctx) => { runtimeConversationState = restoreConversationState(ctx); });
  pi.on("before_agent_start", async (event) => {
    resetTools(pi);
    const stateBlock = `<epos-conversation-state>\nCurrent workflow state: ${JSON.stringify(modelConversationState(runtimeConversationState))}\nReuse confirmed values when relevant. New user instructions take precedence; never invent missing values.\n</epos-conversation-state>`;
    const systemPrompt = event.systemPrompt.replace(/\n*<epos-conversation-state>[\s\S]*?<\/epos-conversation-state>/g, "");
    return { systemPrompt: `${systemPrompt}\n\n${stateBlock}` };
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !event.message.usage) return;
    const usage = event.message.usage;
    const record = {
      timestamp: now(),
      sessionId: ctx.sessionManager.getSessionId(),
      provider: event.message.provider,
      model: event.message.model,
      activeTools: pi.getActiveTools(),
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      reasoning: usage.reasoning,
      total: usage.totalTokens,
      cost: usage.cost,
    };
    await mkdir(join(ROOT, "logs"), { recursive: true });
    await appendFile(TOKEN_LOG, JSON.stringify(record) + "\n");
  });
  pi.on("session_shutdown", async () => { await Promise.all([mcp.stop(), eposMcp.stop()]); });
  pi.on("tool_result", async (event) => {
    const nextState = nextConversationState(runtimeConversationState, event);
    if (!nextState) return;
    runtimeConversationState = nextState;
    await writeStudyDocuments(runtimeConversationState);
    pi.appendEntry<ConversationState>(CONVERSATION_STATE_TYPE, runtimeConversationState);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const input: any = event.input || {};
    const targetPath = input.path;
    if (!targetPath || typeof targetPath !== "string" || !isInsideWorkspace(targetPath, ctx.cwd)) {
      return {
        block: true,
        reason: `EPOS Agent write guard: ${event.toolName} may write only inside ${WORKSPACE}. Requested path: ${targetPath || "(missing)"}`,
        terminate: true,
      };
    }
  });
  pi.registerCommand("epos", { description: "Show EPOS Agent status", handler: async (_args, ctx) => { ctx.ui.notify(`EPOS Agent: tools are selected automatically; study bundles are stored in ${WORKSPACE}`, "info"); } });
  pi.registerCommand("workspace", {
    description: "Show the active study bundle and recent artifacts",
    handler: async (_args, ctx) => {
      const bundle = runtimeConversationState.study?.bundlePath || WORKSPACE;
      const recent = runtimeConversationState.files.slice(-5);
      const openCommand = process.platform === "darwin" ? `open "${bundle}"` : `xdg-open "${bundle}"`;
      ctx.ui.notify([`Workspace: ${bundle}`, `Open: ${openCommand}`, recent.length ? `Recent files:\n${recent.join("\n")}` : "No recorded artifacts in this study."].join("\n"), "info");
    },
  });
  pi.registerCommand("epos-state", {
    description: "Show or reset the current EPOS workflow state",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action) {
        ctx.ui.notify(JSON.stringify(runtimeConversationState, null, 2), "info");
        return;
      }
      if (action !== "reset") {
        ctx.ui.notify("Usage: /epos-state [reset]", "error");
        return;
      }
      runtimeConversationState = emptyConversationState();
      pi.appendEntry<ConversationState>(CONVERSATION_STATE_TYPE, runtimeConversationState);
      ctx.ui.notify("EPOS workflow state reset; session history and files were not changed.", "info");
    },
  });
  pi.registerTool(createLoadToolsTool(pi));
  pi.registerTool(createWorkflowTool());
  pi.registerTool(nativeEposSearchTool);
  pi.registerTool(nativeEposSearchPageTool);
  pi.registerTool(nativeEposSelectCandidateTool);
  pi.registerTool(nativeEposSearchFilterTool);
  pi.registerTool(nativeEposOrganizationsTool);
  pi.registerTool(nativeEposDetailsTool);
  pi.registerTool(nativeEposPrepareExecuteTool);
  pi.registerTool(nativeEposExecuteTool);
  pi.registerTool(nativeEposInspectTool);
  pi.registerTool(nativeEposVisualizeTool);
  pi.registerTool(nativeEposFetchTool);
  pi.registerTool(prepareVisualizationTool);
  pi.registerTool(runPythonTool);
  pi.registerTool(finalizeNotebookTool);
  pi.registerTool(showImageTool);
  pi.registerTool(fdsnMcpTool);
}
