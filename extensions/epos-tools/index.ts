import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface, type Interface } from "node:readline";

const ROOT = process.env.EPOS_AGENT_ROOT || `${process.env.HOME}/epos-agent`;
const PROV_DIR = join(ROOT, "logs", "provenance");
const TOKEN_LOG = join(ROOT, "logs", "token-usage.jsonl");
const FDSN_CMD = join(ROOT, "services", "mcp-fdsnws-event", ".venv", "bin", "mcp-fdsnws-event-server");
const EPOS_MCP_SERVER = join(ROOT, "services", "mcp-epos", "src", "server.mjs");
const EPOS_MCP_NODE = process.env.EPOS_MCP_NODE || "node";
const WORKSPACE = resolve(ROOT, "workspace");
const MCP_PROTOCOL_VERSION = "2025-11-25";
const FDSN_PAGE_SIZE = 1000;
const FDSN_SAMPLE_SIZE = 5;
const MODEL_RESULT_LIMIT = 12000;
const CONFIRM_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const CONVERSATION_STATE_TYPE = "epos-conversation-state";
const MAX_STATE_FILES = 10;

type StateValue = string | number | boolean;
type ConversationState = {
  version: 1;
  intent?: string;
  domain?: string;
  filters: Record<string, StateValue>;
  selectedResourceId?: string;
  format?: string;
  files: string[];
  provenanceFiles: string[];
  updatedAt: string;
};

function emptyConversationState(): ConversationState {
  return { version: 1, filters: {}, files: [], provenanceFiles: [], updatedAt: now() };
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
  if (!data || typeof data !== "object" || (data as any).version !== 1) return undefined;
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
  return state;
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
    if (event.toolName !== "epos_fdsnws_event_call" || payload?.code !== "FDSN_PARTIAL_DOWNLOAD") return undefined;
    return {
      ...current,
      files: recentPaths(current.files, payload.outputFile),
      provenanceFiles: recentPaths(current.provenanceFiles, payload.provenanceFile),
      updatedAt: now(),
    };
  }

  if (event.toolName === "epos_load_tools") {
    const intentByCapability: Record<string, string> = {
      catalog_search: "find_data", software_search: "find_software", description: "describe_data",
      download: "download_data", seismology: "find_earthquakes", analysis: "analyze_data", workspace: "manage_workspace",
    };
    const intent = intentByCapability[input.capability];
    if (!intent) return undefined;
    return { ...current, intent, domain: input.capability === "seismology" ? "seismology" : current.domain, updatedAt: now() };
  }

  if (event.toolName === "epos_search_resources" || event.toolName === "epos_search_software") {
    const filters = pickStateFilters(input, EPOS_FILTER_KEYS);
    return withArtifacts({
      ...emptyConversationState(),
      intent: event.toolName === "epos_search_software" ? "find_software" : "find_data",
      domain: typeof input.scienceDomains === "string" ? input.scienceDomains : undefined,
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
    return withArtifacts({
      ...current,
      intent: input.estimateOnly ? "prepare_download" : "download_data",
      filters,
      selectedResourceId: typeof input.resourceId === "string" ? input.resourceId : current.selectedResourceId,
      format: typeof input.format === "string" ? input.format : current.format,
    }, payload.outputFile, payload.file, payload.path);
  }

  if (event.toolName === "epos_fdsnws_event_call") {
    const args = input.arguments && typeof input.arguments === "object" ? input.arguments : {};
    if (input.toolName === "fdsn_query_earthquakes") {
      return withArtifacts({
        ...emptyConversationState(),
        intent: "download_data",
        domain: "seismology",
        filters: pickStateFilters(args, FDSN_FILTER_KEYS),
        format: "jsonl",
      }, payload.outputFile);
    }
    return withArtifacts({
      ...current,
      intent: "inspect_event",
      domain: "seismology",
      filters: { ...current.filters, ...pickStateFilters(args, FDSN_FILTER_KEYS) },
    }, payload.outputFile);
  }

  if (event.toolName === "epos_run_python") {
    return withArtifacts({ ...current, intent: "analyze_data" }, payload.script, payload.outputLog, input.outputImagePath);
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

class StdioMcpClient {
  constructor(private command: string, private args: string[] = [], private cwd = ROOT) {}
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  async start() {
    if (this.proc && !this.proc.killed) return;
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
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
const eposMcp = new StdioMcpClient(EPOS_MCP_NODE, [EPOS_MCP_SERVER], join(ROOT, "services", "mcp-epos"));
async function eposMcpCall(toolName: string, args: Record<string, unknown>) {
  await eposMcp.start();
  const response = await eposMcp.request("tools/call", { name: toolName, arguments: args });
  if (response?.isError) throw new Error(response.content?.find((c: any) => c.type === "text")?.text || `EPOS MCP tool failed: ${toolName}`);
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
function modelResult(payload: unknown) {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MODEL_RESULT_LIMIT) return { content: [{ type: "text" as const, text: serialized }], details: payload };
  const compact = { truncatedInChat: true, characterCount: serialized.length, preview: serialized.slice(0, MODEL_RESULT_LIMIT) };
  return { content: [{ type: "text" as const, text: JSON.stringify(compact) }], details: payload };
}
async function resultWithProvenance(action: string, parameters: Record<string, unknown>, payload: any) {
  const source = payload?.provenance || {};
  const record = { action, timestamp: source.retrievedAt || now(), parameters, ...source };
  const provenanceFile = await logProvenance(record);
  return modelResult({ ...payload, provenance: { ...record, provenanceFile } });
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

const searchTool = defineTool({
  name: "epos_search_resources",
  label: "EPOS Search Resources",
  description: "Search EPOS resources. Returns up to five compact service cards plus total and next offset.",
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
    return resultWithProvenance("search", params, await eposMcpCall("search_resources", params));
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
    return resultWithProvenance("software-search", params, await eposMcpCall("search_software", params));
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
  description: "Execute an EPOS service and save its complete response in the workspace. Chat receives only counts, path, preview and provenance.",
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
    allowLargeDownload: Type.Optional(Type.Boolean({ description: "Proceed after user confirmation when the response exceeds 50 MB; hard limit is 1 GB" })),
    outputFileName: Type.Optional(Type.String({ description: "Optional filename for saving the downloaded response inside the EPOS workspace" })),
  }),
  async execute(_id, params: any) {
    const action = params.estimateOnly ? "estimate-service" : "execute-service";
    return resultWithProvenance(action, params, await eposMcpCall("execute_service", params));
  },
});

const runPythonTool = defineTool({
  name: "epos_run_python",
  label: "EPOS Run Python",
  description: "Run Python code or a Python script only inside ~/epos-agent/workspace. Use it to process EPOS data, generate plots/PNGs, and optionally return an image inline.",
  parameters: Type.Object({
    code: Type.Optional(Type.String({ description: "Python source to write to a temporary script in the EPOS workspace and run" })),
    scriptPath: Type.Optional(Type.String({ description: "Existing .py script path; must be inside ~/epos-agent/workspace" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Execution timeout in ms; default 60000, max 300000" })),
    outputImagePath: Type.Optional(Type.String({ description: "Optional PNG/JPEG/GIF/WebP path inside workspace to return inline after execution" })),
  }),
  async execute(_id, params: any, signal, _onUpdate, ctx) {
    await mkdir(WORKSPACE, { recursive: true });
    let script: string;
    if (params.code) {
      script = join(WORKSPACE, `.epos-run-${Date.now()}.py`);
      await writeFile(script, params.code);
    } else if (params.scriptPath) {
      if (!isInsideWorkspace(params.scriptPath, ctx.cwd)) throw new Error(`scriptPath must be inside ${WORKSPACE}`);
      script = resolve(ctx.cwd, params.scriptPath);
    } else {
      throw new Error("Provide either code or scriptPath");
    }
    const timeout = Math.max(1000, Math.min(Number(params.timeoutMs || 60000), 300000));
    const args = Array.isArray(params.args) ? params.args : [];
    const { stdout, stderr } = await execFileAsync("python3", [script, ...args], {
      cwd: WORKSPACE,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, MPLBACKEND: "Agg", EPOS_AGENT_ROOT: ROOT, EPOS_WORKSPACE: WORKSPACE },
      signal,
    });
    const record = { action: "run-python", timestamp: now(), workspace: WORKSPACE, script, args, timeoutMs: timeout, stdoutBytes: stdout.length, stderrBytes: stderr.length, outputImagePath: params.outputImagePath };
    const provenanceFile = await logProvenance(record);
    const fullResult = { provenance: { ...record, provenanceFile }, stdout, stderr };
    const serialized = JSON.stringify(fullResult);
    let outputLog: string | undefined;
    let chatResult: unknown = fullResult;
    if (serialized.length > MODEL_RESULT_LIMIT) {
      outputLog = join(WORKSPACE, `epos-python-output-${Date.now()}.json`);
      await writeFile(outputLog, serialized);
      chatResult = { provenance: fullResult.provenance, outputLog, stdoutPreview: stdout.slice(0, 4000), stderrPreview: stderr.slice(0, 2000) };
    }
    const content: any[] = [...modelResult(chatResult).content];
    if (params.outputImagePath) {
      if (!isInsideWorkspace(params.outputImagePath, ctx.cwd)) throw new Error(`outputImagePath must be inside ${WORKSPACE}`);
      content.push(await imageBlock(resolve(ctx.cwd, params.outputImagePath)));
    }
    return { content, details: { ...fullResult, outputLog } };
  },
});

const showImageTool = defineTool({
  name: "epos_show_image",
  label: "EPOS Show Image",
  description: "Display an existing PNG/JPEG/GIF/WebP image from ~/epos-agent/workspace inline in the Pi TUI/chat.",
  parameters: Type.Object({ path: Type.String({ description: "Image path inside ~/epos-agent/workspace" }) }),
  async execute(_id, params: any, _signal, _onUpdate, ctx) {
    if (!isInsideWorkspace(params.path, ctx.cwd)) throw new Error(`Image path must be inside ${WORKSPACE}`);
    const abs = resolve(ctx.cwd, params.path);
    return { content: [{ type: "text", text: `Displaying image: ${abs}` }, await imageBlock(abs)], details: { path: abs, mimeType: imageMime(abs) } };
  },
});

const fdsnMcpTool = defineTool({
  name: "epos_fdsnws_event_call",
  label: "EPOS FDSNWS Event MCP Call",
  description: "Query FDSN earthquake data. With no explicit limit, all pages are fetched to a workspace JSONL file; with a limit, that exact limit is requested. Chat gets a count and at most five samples.",
  parameters: Type.Object({
    toolName: StringEnum(["fdsn_query_earthquakes", "fdsn_get_earthquake_by_id", "fdsn_get_arrivals_by_id", "fdsn_get_allmagnitudes_by_id", "fdsn_get_allorigins_by_id", "fdsn_get_focalmechanism_by_id"] as const),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments for the selected MCP tool. Query names: starttime, endtime, minmag, maxmag, minlat, maxlat, minlon, maxlon, mindepth, maxdepth, latitude, longitude, minradiuskm, maxradiuskm, updatedafter, limit, offset, orderby, datacenter. Detail tools accept eventid and datacenter." })),
    allowLargeDownload: Type.Optional(Type.Boolean({ description: "Proceed after user confirmation if the generated file exceeds 50 MB; 1 GB is always refused" })),
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
      let outputFile: string | undefined;
      if (serialized.length > MODEL_RESULT_LIMIT) {
        await mkdir(WORKSPACE, { recursive: true });
        outputFile = join(WORKSPACE, `fdsn-${safeName(params.toolName)}-${Date.now()}.json`);
        await writeFile(outputFile, serialized);
      }
      return resultWithProvenance("fdsnws-event-mcp", originalArguments, {
        toolName: params.toolName,
        outputFile,
        result: outputFile ? { savedInFull: true, preview: serialized.slice(0, MODEL_RESULT_LIMIT) } : payload,
      });
    }

    await mkdir(WORKSPACE, { recursive: true });
    const datacenter = safeName(originalArguments.datacenter || "INGV");
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const outputFile = join(WORKSPACE, `fdsn-events-${datacenter}-${suffix}.jsonl`);
    const partialFile = outputFile.replace(/\.jsonl$/, ".partial.jsonl");
    const file = await open(outputFile, "w");
    const explicitLimit = Object.prototype.hasOwnProperty.call(originalArguments, "limit");
    const requestedLimit = explicitLimit ? Number(originalArguments.limit) : undefined;
    let offset = Number(originalArguments.offset || 1);
    let recordCount = 0;
    let bytes = 0;
    let pageCount = 0;
    let columns: unknown[] = [];
    const sample: unknown[] = [];
    const endpoints = new Set<string>();
    try {
      while (true) {
        if (signal?.aborted) throw new Error("FDSN download aborted");
        const pageArguments = explicitLimit
          ? originalArguments
          : { ...originalArguments, limit: FDSN_PAGE_SIZE, offset };
        const result = await mcp.request("tools/call", { name: params.toolName, arguments: pageArguments });
        const page = parseMcpPayload(result);
        if (page?.error) throw new Error(JSON.stringify(page));
        pageCount += 1;
        if (page.api_url) endpoints.add(page.api_url);
        if (Array.isArray(page.columns) && page.columns.length) columns = page.columns;
        const rows = Array.isArray(page.rows) ? page.rows : [];
        for (const row of rows) {
          const event = jsonlRow(columns, row);
          const line = JSON.stringify(event) + "\n";
          const lineBytes = Buffer.byteLength(line);
          if (bytes + lineBytes > MAX_DOWNLOAD_BYTES) throw new Error("FDSN dataset exceeds the absolute 1 GB safety limit");
          if (bytes + lineBytes > CONFIRM_DOWNLOAD_BYTES && !params.allowLargeDownload) {
            throw new Error("FDSN dataset exceeds 50 MB and requires explicit confirmation");
          }
          await file.write(line);
          bytes += lineBytes;
          recordCount += 1;
          if (sample.length < FDSN_SAMPLE_SIZE) sample.push(event);
        }
        if (explicitLimit || !page.pagination?.has_more || rows.length === 0) break;
        const nextOffset = Number(page.pagination.next_offset ?? offset + rows.length);
        if (!Number.isFinite(nextOffset) || nextOffset <= offset) throw new Error(`Invalid FDSN next_offset: ${page.pagination.next_offset}`);
        offset = nextOffset;
      }
      await file.close();
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
        bytes,
        outputFile,
        complete: true,
      };
      const provenanceFile = await logProvenance(record);
      return modelResult({ recordCount, pageCount, bytes, outputFile, complete: true, sample, provenance: { ...record, provenanceFile } });
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
        bytes,
        outputFile: retainedFile,
        complete: false,
        error: error instanceof Error ? error.message : String(error),
      };
      const provenanceFile = await logProvenance(record);
      throw new Error(JSON.stringify({ code: "FDSN_PARTIAL_DOWNLOAD", complete: false, recordCount, outputFile: retainedFile, provenanceFile, error: record.error }));
    }
  },
});

const BASE_TOOLS = ["read", "epos_load_tools"];
const TOOL_GROUPS: Record<string, string[]> = {
  catalog_search: ["epos_search_organizations", "epos_search_resources"],
  software_search: ["epos_search_software"],
  description: ["epos_describe_resource", "epos_describe_software", "epos_describe_service"],
  download: ["epos_describe_service", "epos_execute_service"],
  seismology: ["epos_fdsnws_event_call"],
  analysis: ["read", "epos_run_python", "epos_show_image"],
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
      capability: StringEnum(["catalog_search", "software_search", "description", "download", "seismology", "analysis", "workspace"] as const),
    }),
    async execute(_id, params: any) {
      const available = availableToolNames(pi);
      const requested = TOOL_GROUPS[params.capability] || [];
      const activeTools = [...new Set([...BASE_TOOLS, ...requested])].filter(name => available.has(name));
      pi.setActiveTools(activeTools);
      return modelResult({ capability: params.capability, activeTools });
    },
  });
}

export default function (pi: ExtensionAPI) {
  let conversationState = emptyConversationState();

  pi.on("session_start", async (_event, ctx) => {
    // Do not keep the large logo as a persistent widget: it crowds the editor area.
    // The full ASCII-art logo is printed once by the launcher before Pi starts.
    ctx.ui.setTitle("EPOS Agent");
    ctx.ui.setWorkingIndicator({ frames: ["🌍", "🌎", "🌏"], intervalMs: 180 });
    ctx.ui.setStatus("epos", "EPOS Agent");
    ctx.ui.setStatus("epos-api-mcp", "EPOS API MCP on demand");
    ctx.ui.setStatus("epos-fdsn", "FDSN MCP on demand");
    conversationState = restoreConversationState(ctx);
    resetTools(pi);
  });
  pi.on("session_tree", async (_event, ctx) => { conversationState = restoreConversationState(ctx); });
  pi.on("before_agent_start", async (event) => {
    resetTools(pi);
    const stateBlock = `<epos-conversation-state>\nCurrent workflow state: ${JSON.stringify(conversationState)}\nReuse confirmed values when relevant. New user instructions take precedence; never invent missing values.\n</epos-conversation-state>`;
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
    const nextState = nextConversationState(conversationState, event);
    if (!nextState) return;
    conversationState = nextState;
    pi.appendEntry<ConversationState>(CONVERSATION_STATE_TYPE, conversationState);
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
  pi.registerCommand("epos", { description: "Show EPOS Agent status", handler: async (_args, ctx) => { ctx.ui.notify("EPOS Agent: tools are selected automatically; complete datasets are stored in ~/epos-agent/workspace", "info"); } });
  pi.registerCommand("epos-state", {
    description: "Show or reset the current EPOS workflow state",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action) {
        ctx.ui.notify(JSON.stringify(conversationState, null, 2), "info");
        return;
      }
      if (action !== "reset") {
        ctx.ui.notify("Usage: /epos-state [reset]", "error");
        return;
      }
      conversationState = emptyConversationState();
      pi.appendEntry<ConversationState>(CONVERSATION_STATE_TYPE, conversationState);
      ctx.ui.notify("EPOS workflow state reset; session history and files were not changed.", "info");
    },
  });
  pi.registerTool(createLoadToolsTool(pi));
  pi.registerTool(organizationSearchTool);
  pi.registerTool(searchTool);
  pi.registerTool(softwareSearchTool);
  pi.registerTool(describeResourceTool);
  pi.registerTool(describeSoftwareTool);
  pi.registerTool(describeServiceTool);
  pi.registerTool(executeTool);
  pi.registerTool(runPythonTool);
  pi.registerTool(showImageTool);
  pi.registerTool(fdsnMcpTool);
}
