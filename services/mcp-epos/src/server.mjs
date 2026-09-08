import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = (process.env.EPOS_API_BASE || "https://www.ics-c.epos-eu.org/api/v1").replace(/\/$/, "");

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
  "Execute an EPOS external service by its catalogue instance ID. The caller must validate parameters from metadata first.",
  {
    instance_id: z.string().min(1), useDefaults: z.boolean().optional(), format: z.string().optional(),
    startDate: z.string().optional(), endDate: z.string().optional(), bbox: z.string().optional(),
    pluginId: z.string().optional(), inputFormat: z.string().optional(), params: z.string().optional(),
  },
  async ({ instance_id, ...query }) => result(await get(`/execute/${encodeURIComponent(instance_id)}`, query)),
);

server.tool(
  "search_processing_services",
  "Search EPOS processing services. Use this for processing workflows, not ordinary resources or software.",
  {},
  async () => result(await get("/processing/search")),
);

const transport = new StdioServerTransport();
await server.connect(transport);
