import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, open, unlink } from "node:fs/promises";
import { join, basename } from "node:path";

const API_BASE = (process.env.EPOS_API_BASE || "https://www.ics-c.epos-eu.org/api/v1").replace(/\/$/, "");
const WORKSPACE = process.env.EPOS_WORKSPACE || join(process.env.EPOS_AGENT_ROOT || process.cwd(), "workspace");
const DEFAULT_DOWNLOAD_LIMIT = 50 * 1024 * 1024;
const ABSOLUTE_DOWNLOAD_LIMIT = 1024 * 1024 * 1024;

function apiUrl(path, params = {}) {
  const u = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    u.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return u;
}

async function get(path, params = {}) {
  const endpoint = apiUrl(path, params);
  const response = await fetch(endpoint, { headers: { accept: "application/json,*/*" } });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`EPOS API HTTP ${response.status} ${response.statusText}: ${endpoint}`);
  return { data, endpoint: endpoint.toString(), status: response.status, contentType: response.headers.get("content-type") || "unknown", bytes: new TextEncoder().encode(text).length };
}

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({ name: "epos-api", version: "0.1.0" });

server.tool(
  "search_resources",
  "Search EPOS scientific resources and executable service distributions. Use this for data/services, not software.",
  {
    q: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), bbox: z.string().optional(),
    keywords: z.string().optional(), sciencedomains: z.string().optional(), servicetypes: z.string().optional(),
    organisations: z.string().optional(), facetstype: z.string().optional(), facets: z.boolean().optional(),
    versioningStatus: z.string().optional(),
  },
  async (params) => result(await get("/resources/search", params)),
);

server.tool(
  "search_software",
  "Search software catalogued by EPOS. Use this instead of search_resources for software questions.",
  { q: z.string().optional(), versioningStatus: z.string().optional() },
  async (params) => result(await get("/software/search", params)),
);

server.tool(
  "get_resource_details",
  "Get detailed metadata for one EPOS resource/distribution instance ID.",
  { instance_id: z.string().min(1), extended: z.boolean().optional() },
  async ({ instance_id, extended }) => result(await get(`/resources/details/${encodeURIComponent(instance_id)}`, { extended })),
);

server.tool(
  "get_software_details",
  "Get detailed metadata for one EPOS software instance ID.",
  { instance_id: z.string().min(1) },
  async ({ instance_id }) => result(await get(`/software/details/${encodeURIComponent(instance_id)}`)),
);

server.tool(
  "get_service_parameters",
  "Get the parameters linked to one executable EPOS resource instance ID.",
  { instance_id: z.string().min(1) },
  async ({ instance_id }) => result(await get(`/resources/linkedentities/parameters/${encodeURIComponent(instance_id)}`)),
);

server.tool(
  "execute_service",
  "Execute an EPOS external service with a 50 MB confirmation threshold and a hard 1 GB safety limit. Large results are streamed to the EPOS workspace.",
  {
    instance_id: z.string().min(1), useDefaults: z.boolean().optional(), format: z.string().optional(),
    startDate: z.string().optional(), endDate: z.string().optional(), bbox: z.string().optional(),
    pluginId: z.string().optional(), inputFormat: z.string().optional(), params: z.string().optional(),
    estimate_only: z.boolean().optional(), allowLargeDownload: z.boolean().optional(), outputFileName: z.string().optional(),
  },
  async ({ instance_id, estimate_only, allowLargeDownload, outputFileName, ...query }) => {
    const endpoint = apiUrl(`/execute/${encodeURIComponent(instance_id)}`, query);
    const head = await fetch(endpoint, { method: "HEAD", headers: { accept: query.format || "*/*" } });
    const headerLength = Number(head.headers.get("content-length"));
    const contentLength = Number.isFinite(headerLength) && headerLength >= 0 ? headerLength : null;
    const contentType = head.headers.get("content-type") || "unknown";
    const estimate = { endpoint: endpoint.toString(), status: head.status, contentType, contentLength, defaultLimitBytes: DEFAULT_DOWNLOAD_LIMIT, absoluteLimitBytes: ABSOLUTE_DOWNLOAD_LIMIT };
    if (estimate_only) return result({ estimate, estimateAvailable: contentLength !== null, note: contentLength === null ? "The service did not provide Content-Length; no data was downloaded." : undefined });
    if (head.status >= 400 && head.status !== 405 && head.status !== 501) throw new Error(`EPOS preflight failed: HTTP ${head.status} from ${endpoint}`);
    if (contentLength !== null && contentLength > ABSOLUTE_DOWNLOAD_LIMIT) throw new Error(JSON.stringify({ code: "DOWNLOAD_LIMIT_EXCEEDED", message: "The estimated response exceeds the absolute 1 GB limit.", ...estimate }));
    if (contentLength !== null && contentLength > DEFAULT_DOWNLOAD_LIMIT && !allowLargeDownload) throw new Error(JSON.stringify({ code: "DOWNLOAD_CONFIRMATION_REQUIRED", message: "The estimated response exceeds 50 MB. Ask the user for confirmation before retrying with allowLargeDownload=true.", ...estimate }));
    if (outputFileName && basename(outputFileName) !== outputFileName) throw new Error("outputFileName must be a filename inside the EPOS workspace, not a path.");
    const response = await fetch(endpoint, { headers: { accept: query.format || "*/*" } });
    if (!response.ok) throw new Error(`EPOS execute failed: HTTP ${response.status} ${response.statusText} from ${endpoint}`);
    const responseLength = Number(response.headers.get("content-length"));
    const totalLength = Number.isFinite(responseLength) && responseLength >= 0 ? responseLength : contentLength;
    if (totalLength !== null && totalLength > ABSOLUTE_DOWNLOAD_LIMIT) throw new Error(JSON.stringify({ code: "DOWNLOAD_LIMIT_EXCEEDED", message: "The response exceeds the absolute 1 GB limit.", endpoint: endpoint.toString(), contentLength: totalLength }));
    const filePath = outputFileName ? join(WORKSPACE, outputFileName) : undefined;
    let file;
    const previewChunks = [];
    let previewBytes = 0;
    let downloadedBytes = 0;
    try {
      if (filePath) { await mkdir(WORKSPACE, { recursive: true }); file = await open(filePath, "w"); }
      if (!response.body) throw new Error("EPOS response has no readable body");
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        downloadedBytes += value.byteLength;
        if (downloadedBytes > ABSOLUTE_DOWNLOAD_LIMIT) throw new Error(JSON.stringify({ code: "DOWNLOAD_LIMIT_EXCEEDED", message: "The streaming response exceeded the absolute 1 GB limit.", endpoint: endpoint.toString() }));
        if (downloadedBytes > DEFAULT_DOWNLOAD_LIMIT && !allowLargeDownload) throw new Error(JSON.stringify({ code: "DOWNLOAD_CONFIRMATION_REQUIRED", message: "The response exceeded 50 MB while streaming. Ask the user for confirmation before retrying.", endpoint: endpoint.toString(), downloadedBytes }));
        if (file) await file.write(value);
        if (previewBytes < 50000) { const part = value.slice(0, Math.min(value.byteLength, 50000 - previewBytes)); previewChunks.push(part); previewBytes += part.byteLength; }
      }
    } catch (error) {
      if (filePath) await unlink(filePath).catch(() => {});
      throw error;
    } finally { await file?.close(); }
    const preview = new TextDecoder().decode(Buffer.concat(previewChunks.map((x) => Buffer.from(x))));
    return result({ endpoint: endpoint.toString(), status: response.status, contentType: response.headers.get("content-type") || contentType, bytes: downloadedBytes, contentLength: totalLength, outputFile: filePath, data: preview, truncated: downloadedBytes > previewBytes });
  },
);

server.tool(
  "search_processing_services",
  "Search EPOS processing services. Use this for processing workflows, not ordinary resources or software.",
  {},
  async () => result(await get("/processing/search")),
);

const transport = new StdioServerTransport();
await server.connect(transport);
