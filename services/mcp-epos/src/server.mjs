import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";

const API_BASE = (process.env.EPOS_API_BASE || "https://www.ics-c.epos-eu.org/api/v1").replace(/\/$/, "");
const WORKSPACE = process.env.EPOS_WORKSPACE || join(process.env.EPOS_AGENT_ROOT || process.cwd(), "workspace");
const ABSOLUTE_DOWNLOAD_LIMIT = 1024 * 1024 * 1024;
const DEFAULT_PREVIEW_BYTES = 4000;
const MAX_PREVIEW_BYTES = 12000;

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const provenanceShape = {
  endpoint: z.string(),
  retrievedAt: z.string(),
  status: z.number(),
  contentType: z.string(),
  sourceBytes: z.number(),
};

class EposApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, { code: "EPOS_API_ERROR", ...details });
  }
}

function apiUrl(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return url;
}

async function get(path, params = {}) {
  const endpoint = apiUrl(path, params);
  const response = await fetch(endpoint, { headers: { accept: "application/json,*/*" } });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new EposApiError(`EPOS API returned HTTP ${response.status} ${response.statusText}.`, {
      endpoint: endpoint.toString(),
      status: response.status,
    });
  }
  return {
    data,
    endpoint: endpoint.toString(),
    status: response.status,
    contentType: response.headers.get("content-type") || "unknown",
    bytes: Buffer.byteLength(text),
    retrievedAt: new Date().toISOString(),
  };
}

function structuredResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(error) {
  const payload = {
    error: true,
    code: error?.code || "EPOS_TOOL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    status: error?.status,
    endpoint: error?.endpoint,
    outputFile: error?.outputFile,
    bytes: error?.bytes,
    complete: error?.complete,
    datasetCompleteness: error?.datasetCompleteness,
    pageCount: error?.pageCount,
    coverage: error?.coverage,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

function safeTool(handler) {
  return async (...args) => {
    try { return await handler(...args); }
    catch (error) { return errorResult(error); }
  };
}

function compactText(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function collectDistributions(node, out = [], domains = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectDistributions(item, out, domains);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const nextDomains = node.name && node.code
    ? [...domains, { name: String(node.name), code: String(node.code) }]
    : domains;
  if (Array.isArray(node.distributions)) {
    out.push(...node.distributions.map((distribution) => ({ ...distribution, _catalogDomains: nextDomains })));
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "distributions") collectDistributions(value, out, nextDomains);
  }
  return out;
}

function collectLabels(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectLabels(item, out);
  } else if (typeof value === "string" || typeof value === "number") {
    out.push(String(value));
  } else if (value && typeof value === "object") {
    const label = value.label ?? value.name ?? value.title ?? value.dataProviderLegalName;
    if (label !== undefined) collectLabels(label, out);
  }
  return [...new Set(out.filter(Boolean))];
}

function providers(resource) {
  return collectLabels([
    resource.dataServiceProvider,
    resource.dataProvider,
    resource.serviceProvider,
  ]);
}

function formats(resource) {
  return [...new Set((resource.availableFormats || []).map((format) => (
    format?.label || format?.format || format?.type || format
  )).filter((format) => typeof format === "string" && format))];
}

function resourceDomains(resource) {
  return collectLabels([
    resource.scienceDomain,
    ...(resource._catalogDomains || []).map((domain) => domain.name),
  ]);
}

function normalizedSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function searchTokens(value) {
  return [...new Set(normalizedSearchText(value).split(" ").filter(Boolean))];
}

function tokenMatches(text, tokens) {
  const words = new Set(text.split(" ").filter(Boolean));
  return tokens.reduce((count, token) => count + Number(words.has(token)), 0);
}

function resourceRank(resource, query) {
  const phrase = normalizedSearchText(query);
  const tokens = searchTokens(query);
  const title = normalizedSearchText(resource.title);
  const providerAndDomain = normalizedSearchText([...providers(resource), ...resourceDomains(resource)].join(" "));
  const description = normalizedSearchText(resource.description);
  return [
    Number(title === phrase),
    Number(Boolean(phrase) && title.includes(phrase)),
    tokenMatches(title, tokens),
    Number(Boolean(phrase) && providerAndDomain.includes(phrase)),
    tokenMatches(providerAndDomain, tokens),
    Number(Boolean(phrase) && description.includes(phrase)),
    tokenMatches(description, tokens),
  ];
}

function compareRanks(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

function rankResources(resources, query) {
  if (!normalizedSearchText(query)) return resources;
  return resources
    .map((resource, index) => ({ resource, index, rank: resourceRank(resource, query) }))
    .sort((left, right) => compareRanks(left.rank, right.rank) || left.index - right.index)
    .map(({ resource }) => resource);
}

function deduplicateById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id) return true;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function filterByScienceDomains(resources, scienceDomains) {
  const requested = String(scienceDomains || "").split(",").map(normalizedSearchText).filter(Boolean);
  if (!requested.length) return resources;
  return resources.filter((resource) => {
    const available = [
      ...resourceDomains(resource),
      ...(resource._catalogDomains || []).map((domain) => domain.code),
    ].map(normalizedSearchText);
    return requested.some((domain) => available.includes(domain));
  });
}

function organizationRank(organization, query) {
  const phrase = normalizedSearchText(query);
  const name = normalizedSearchText(organization.name);
  const words = new Set(name.split(" ").filter(Boolean));
  const url = normalizedSearchText(organization.url);
  return [
    Number(name === phrase),
    Number(Boolean(phrase) && name.startsWith(phrase)),
    Number(words.has(phrase)),
    Number(Boolean(phrase) && name.includes(phrase)),
    Number(Boolean(phrase) && url.includes(phrase)),
  ];
}

function resourceCard(resource) {
  return {
    id: resource.id,
    title: resource.title,
    provider: providers(resource),
    domains: resourceDomains(resource),
    formats: formats(resource),
    summary: compactText(resource.description, 240),
    status: typeof resource.status === "number" ? resource.status : undefined,
  };
}

function softwareCard(software) {
  return {
    id: software.id,
    title: software.title,
    provider: providers(software),
    domains: collectLabels(software.scienceDomain),
    formats: formats(software),
    summary: compactText(software.description, 240),
  };
}

function normalizedParameter(parameter) {
  const enumValues = parameter.Enum ?? parameter.enum ?? parameter.allowedValues;
  return {
    name: parameter.name,
    label: parameter.label,
    description: compactText(parameter.description ?? parameter.valueDescription, 400),
    type: parameter.type ?? parameter.valueType,
    required: Boolean(parameter.required),
    readOnly: String(parameter.readOnlyValue ?? parameter.readOnly) === "true",
    default: parameter.defaultValue ?? parameter.default,
    enum: Array.isArray(enumValues) ? enumValues : undefined,
    pattern: parameter.valuePattern ?? parameter.pattern,
  };
}

function provenance(response) {
  return {
    endpoint: response.endpoint,
    retrievedAt: response.retrievedAt,
    status: response.status,
    contentType: response.contentType,
    sourceBytes: response.bytes,
  };
}

function page(items, offset, limit) {
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  return {
    totalResults: items.length,
    offset,
    limit,
    hasMore: nextOffset < items.length,
    nextOffset: nextOffset < items.length ? nextOffset : undefined,
    selected,
  };
}

function validateServiceParameters(metadata, provided, useDefaults) {
  const specifications = metadata.serviceParameters || [];
  const allowed = new Map(specifications.map((parameter) => [parameter.name, parameter]));
  const unknown = Object.keys(provided).filter((name) => !allowed.has(name));
  if (unknown.length) {
    throw new EposApiError(`Unknown service parameters: ${unknown.join(", ")}.`, { code: "INVALID_PARAMETERS" });
  }
  const missing = specifications
    .filter((parameter) => parameter.required
      && String(parameter.readOnlyValue) !== "true"
      && provided[parameter.name] === undefined
      && !useDefaults
      && parameter.defaultValue === undefined)
    .map((parameter) => parameter.name);
  if (missing.length) {
    throw new EposApiError(`Missing required service parameters: ${missing.join(", ")}.`, { code: "MISSING_PARAMETERS" });
  }
  for (const [name, value] of Object.entries(provided)) {
    const specification = allowed.get(name);
    const enumValues = specification?.Enum;
    if (!Array.isArray(enumValues)) continue;
    const values = Array.isArray(value) ? value : [value];
    const invalid = values.filter((item) => !enumValues.includes(String(item)));
    if (invalid.length) {
      throw new EposApiError(`Invalid value for ${name}: ${invalid.join(", ")}.`, { code: "INVALID_PARAMETERS" });
    }
  }
}

function extensionFor(contentType, format) {
  const value = `${contentType || ""} ${format || ""}`.toLowerCase();
  if (value.includes("json")) return ".json";
  if (value.includes("csv")) return ".csv";
  if (value.includes("xml")) return ".xml";
  if (value.includes("yaml") || value.includes("yml")) return ".yaml";
  if (value.includes("zip")) return ".zip";
  if (value.includes("netcdf")) return ".nc";
  if (value.includes("png")) return ".png";
  if (value.includes("jpeg") || value.includes("jpg")) return ".jpg";
  if (value.includes("text")) return ".txt";
  return ".bin";
}

function generatedFileName(resourceId, contentType, format) {
  const safeId = resourceId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32) || "resource";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `epos-${safeId}-${timestamp}${extensionFor(contentType, format)}`;
}

function outputDirectoryPath(outputDirectory) {
  if (!outputDirectory) return WORKSPACE;
  if (isAbsolute(outputDirectory)) {
    throw new EposApiError("outputDirectory must be relative to the EPOS workspace.", { code: "INVALID_OUTPUT_DIRECTORY" });
  }
  const target = resolve(WORKSPACE, outputDirectory);
  if (target !== WORKSPACE && !target.startsWith(WORKSPACE + sep)) {
    throw new EposApiError("outputDirectory must remain inside the EPOS workspace.", { code: "INVALID_OUTPUT_DIRECTORY" });
  }
  return target;
}

function partialFileName(filePath) {
  const extension = extname(filePath);
  return extension ? `${filePath.slice(0, -extension.length)}.partial${extension}` : `${filePath}.partial`;
}

function isTextual(contentType) {
  return /(^text\/|json|xml|csv|yaml|javascript)/i.test(contentType || "");
}

const server = new McpServer({ name: "epos-api", version: "0.2.0" });

server.registerTool("search_resources", {
  description: "Search the EPOS catalogue for scientific data and services. Returns one compact page of service candidates, never the scientific dataset itself.",
  inputSchema: {
    q: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    bbox: z.string().optional(),
    keywords: z.string().optional(),
    scienceDomains: z.string().optional(),
    serviceTypes: z.string().optional(),
    organizations: z.string().optional(),
    versioningStatus: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(5).default(5),
  },
  outputSchema: {
    totalResults: z.number(), offset: z.number(), limit: z.number(), hasMore: z.boolean(),
    totalBeforeLocalFilters: z.number(), appliedLocally: z.array(z.string()),
    nextOffset: z.number().optional(), resources: z.array(z.object({
      id: z.string(), title: z.string().optional(), provider: z.array(z.string()),
      domains: z.array(z.string()), formats: z.array(z.string()), summary: z.string().optional(),
      status: z.number().int().optional(),
    })),
    provenance: z.object(provenanceShape),
  },
  annotations: READ_ANNOTATIONS,
}, safeTool(async ({ scienceDomains, serviceTypes, organizations, offset, limit, ...filters }) => {
  const response = await get("/resources/search", {
    ...filters,
    servicetypes: serviceTypes,
    organisations: organizations,
  });
  const sourceResources = deduplicateById(collectDistributions(response.data?.results));
  const filteredResources = filterByScienceDomains(sourceResources, scienceDomains);
  const resources = rankResources(filteredResources, filters.q);
  const resultPage = page(resources, offset, limit);
  return structuredResult({
    totalResults: resultPage.totalResults,
    totalBeforeLocalFilters: sourceResources.length,
    appliedLocally: scienceDomains ? ["scienceDomains"] : [],
    offset,
    limit,
    hasMore: resultPage.hasMore,
    nextOffset: resultPage.nextOffset,
    resources: resultPage.selected.map(resourceCard),
    provenance: provenance(response),
  });
}));

server.registerTool("search_organizations", {
  description: "Resolve an EPOS provider name to organization IDs. Returns one compact, locally filtered page.",
  inputSchema: {
    q: z.string().min(1),
    country: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(5).default(5),
  },
  outputSchema: {
    totalResults: z.number(), offset: z.number(), limit: z.number(), hasMore: z.boolean(),
    nextOffset: z.number().optional(), organizations: z.array(z.object({
      id: z.string(), name: z.string(), country: z.string().optional(), url: z.string().optional(),
    })),
    provenance: z.object(provenanceShape),
  },
  annotations: READ_ANNOTATIONS,
}, safeTool(async ({ q, country, offset, limit }) => {
  const response = await get("/resources/organizations", { q, country });
  const source = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.data?.organizations) ? response.data.organizations : response.data?.id ? [response.data] : [];
  const normalizedQuery = normalizedSearchText(q);
  const normalizedCountry = normalizedSearchText(country);
  const organizations = deduplicateById(source)
    .filter((organization) => {
      const searchable = normalizedSearchText(`${organization.name || ""} ${organization.url || ""}`);
      const countryMatches = !normalizedCountry || normalizedSearchText(organization.country) === normalizedCountry;
      return searchable.includes(normalizedQuery) && countryMatches;
    })
    .map((organization, index) => ({ organization, index, rank: organizationRank(organization, q) }))
    .sort((left, right) => compareRanks(left.rank, right.rank) || left.index - right.index)
    .map(({ organization }) => organization);
  const resultPage = page(organizations, offset, limit);
  return structuredResult({
    totalResults: resultPage.totalResults,
    offset,
    limit,
    hasMore: resultPage.hasMore,
    nextOffset: resultPage.nextOffset,
    organizations: resultPage.selected.map((organization) => ({
      id: organization.id,
      name: organization.name,
      country: organization.country,
      url: organization.url,
    })),
    provenance: provenance(response),
  });
}));

server.registerTool("search_software", {
  description: "Search software catalogued by EPOS. Returns a compact, locally paginated list.",
  inputSchema: {
    q: z.string().optional(),
    versioningStatus: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(5).default(5),
  },
  outputSchema: {
    totalResults: z.number(), offset: z.number(), limit: z.number(), hasMore: z.boolean(),
    nextOffset: z.number().optional(), software: z.array(z.object({
      id: z.string(), title: z.string().optional(), provider: z.array(z.string()),
      domains: z.array(z.string()), formats: z.array(z.string()), summary: z.string().optional(),
    })),
    provenance: z.object(provenanceShape),
  },
  annotations: READ_ANNOTATIONS,
}, safeTool(async ({ offset, limit, ...filters }) => {
  const response = await get("/software/search", filters);
  const software = collectDistributions(response.data?.results);
  const resultPage = page(software, offset, limit);
  return structuredResult({
    totalResults: resultPage.totalResults,
    offset,
    limit,
    hasMore: resultPage.hasMore,
    nextOffset: resultPage.nextOffset,
    software: resultPage.selected.map(softwareCard),
    provenance: provenance(response),
  });
}));

server.registerTool("describe_resource", {
  description: "Describe one EPOS scientific resource using compact authoritative metadata.",
  inputSchema: { resourceId: z.string().min(1) },
  outputSchema: {
    resource: z.object({
      id: z.string(), metaId: z.string().optional(), uid: z.string().optional(), title: z.string().optional(),
      description: z.string().optional(), provider: z.array(z.string()), domains: z.array(z.string()),
      keywords: z.array(z.string()), formats: z.array(z.string()), accessRights: z.string().optional(),
      license: z.string().optional(), spatialCoverage: z.string().optional(), temporalCoverage: z.string().optional(),
    }),
    provenance: z.object(provenanceShape),
  },
  annotations: READ_ANNOTATIONS,
}, safeTool(async ({ resourceId }) => {
  const response = await get(`/resources/details/${encodeURIComponent(resourceId)}`);
  const resource = response.data || {};
  return structuredResult({
    resource: {
      id: resource.id || resourceId,
      metaId: resource.metaId,
      uid: resource.uid,
      title: resource.title,
      description: compactText(resource.description, 1200),
      provider: providers(resource),
      domains: collectLabels(resource.scienceDomain),
      keywords: collectLabels(resource.keywords),
      formats: formats(resource),
      accessRights: compactText(resource.accessRights, 240),
      license: compactText(resource.license, 240),
      spatialCoverage: compactText(resource.spatial ?? resource.serviceSpatial, 500),
      temporalCoverage: compactText(resource.temporalCoverage ?? resource.serviceTemporalCoverage, 500),
    },
    provenance: provenance(response),
  });
}));

server.registerTool("describe_software", {
  description: "Describe one EPOS software item using compact authoritative metadata.",
  inputSchema: { softwareId: z.string().min(1) },
  outputSchema: {
    software: z.object({
      id: z.string(), uid: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
      formats: z.array(z.string()), documentation: z.string().optional(), source: z.string().optional(),
    }),
    provenance: z.object(provenanceShape),
  },
  annotations: READ_ANNOTATIONS,
}, safeTool(async ({ softwareId }) => {
  const response = await get(`/software/details/${encodeURIComponent(softwareId)}`);
  const software = response.data || {};
  return structuredResult({
    software: {
      id: software.id || softwareId,
      uid: software.uid,
      title: software.title,
      description: compactText(software.description, 1200),
      formats: formats(software),
      documentation: compactText(software.documentation ?? software.href, 500),
      source: compactText(software.codeRepository ?? software.source, 500),
    },
    provenance: provenance(response),
  });
}));

server.registerTool("describe_service", {
  description: "Describe one executable EPOS service, including its endpoint, formats and normalized parameters.",
  inputSchema: { resourceId: z.string().min(1) },
  outputSchema: {
    service: z.object({
      resourceId: z.string(), metaId: z.string().optional(), title: z.string().optional(),
      name: z.string().optional(), description: z.string().optional(), provider: z.array(z.string()),
      endpoint: z.string().optional(), documentation: z.string().optional(), formats: z.array(z.string()),
      spatialCoverage: z.string().optional(), temporalCoverage: z.string().optional(),
      parameters: z.array(z.object({
        name: z.string(), label: z.string().optional(), description: z.string().optional(), type: z.unknown().optional(), required: z.boolean(), readOnly: z.boolean(),
        default: z.unknown().optional(), enum: z.array(z.unknown()).optional(), pattern: z.string().optional(),
      })),
    }),
    provenance: z.object(provenanceShape),
  },
  annotations: READ_ANNOTATIONS,
}, safeTool(async ({ resourceId }) => {
  const response = await get(`/resources/details/${encodeURIComponent(resourceId)}`);
  const metadata = response.data || {};
  return structuredResult({
    service: {
      resourceId: metadata.id || resourceId,
      metaId: metadata.metaId,
      title: metadata.title,
      name: metadata.serviceName,
      description: compactText(metadata.serviceDescription, 800),
      provider: providers(metadata),
      endpoint: metadata.serviceEndpoint ?? metadata.endpoint,
      documentation: compactText(metadata.serviceDocumentation, 500),
      formats: formats(metadata),
      spatialCoverage: compactText(metadata.spatial ?? metadata.serviceSpatial, 500),
      temporalCoverage: compactText(metadata.temporalCoverage ?? metadata.serviceTemporalCoverage, 500),
      parameters: (metadata.serviceParameters || []).map(normalizedParameter),
    },
    provenance: provenance(response),
  });
}));

server.registerTool("execute_service", {
  description: "Validate and execute one read-only EPOS service. The full transport response is streamed within the remaining study budget; scientific dataset completeness is reported separately.",
  inputSchema: {
    resourceId: z.string().min(1),
    format: z.string().optional(),
    inputFormat: z.string().optional(),
    pluginId: z.string().optional(),
    useDefaults: z.boolean().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    bbox: z.string().optional(),
    serviceParameters: z.record(z.unknown()).optional(),
    estimateOnly: z.boolean().optional(),
    allowLargeDownload: z.boolean().optional(),
    outputFileName: z.string().optional(),
    outputDirectory: z.string().optional(),
    maxDownloadBytes: z.number().int().min(0).max(ABSOLUTE_DOWNLOAD_LIMIT).optional(),
    previewBytes: z.number().int().min(0).max(MAX_PREVIEW_BYTES).optional(),
  },
  outputSchema: {
    estimate: z.object({
      endpoint: z.string(), status: z.number(), contentType: z.string(), contentLength: z.number().nullable(),
      confirmationRequired: z.boolean(), absoluteLimitBytes: z.number(),
    }).optional(),
    estimateAvailable: z.boolean().optional(),
    endpoint: z.string().optional(), status: z.number().optional(), contentType: z.string().optional(),
    bytes: z.number().optional(), outputFile: z.string().optional(), preview: z.string().optional(),
    truncated: z.boolean().optional(), complete: z.boolean().optional(), retrievedAt: z.string().optional(),
    transportComplete: z.boolean().optional(),
    datasetCompleteness: z.enum(["verified", "not_verifiable", "partial"]).optional(),
    pageCount: z.number().int().optional(),
    coverage: z.object({
      requestedStart: z.string().optional(), requestedEnd: z.string().optional(),
      requestedBbox: z.string().optional(), verified: z.boolean(),
    }).optional(),
    provenance: z.object(provenanceShape).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
}, safeTool(async ({
  resourceId, serviceParameters = {}, estimateOnly, allowLargeDownload, outputFileName,
  outputDirectory, maxDownloadBytes,
  previewBytes = DEFAULT_PREVIEW_BYTES, ...query
}) => {
  if (outputFileName && (basename(outputFileName) !== outputFileName || outputFileName === "." || outputFileName === "..")) {
    throw new EposApiError("outputFileName must be a filename inside the EPOS workspace.", { code: "INVALID_OUTPUT_FILE" });
  }

  const details = await get(`/resources/details/${encodeURIComponent(resourceId)}`);
  validateServiceParameters(details.data || {}, serviceParameters, query.useDefaults);
  const gatewayQuery = { ...query };
  if (Object.keys(serviceParameters).length) gatewayQuery.params = JSON.stringify(serviceParameters);

  const endpoint = apiUrl(`/execute/${encodeURIComponent(resourceId)}`, gatewayQuery);
  const head = await fetch(endpoint, { method: "HEAD", headers: { accept: query.format || "*/*" } });
  const headerLength = Number(head.headers.get("content-length"));
  const contentLength = Number.isFinite(headerLength) && headerLength >= 0 ? headerLength : null;
  const contentType = head.headers.get("content-type") || "unknown";
  const effectiveLimit = Math.min(maxDownloadBytes ?? ABSOLUTE_DOWNLOAD_LIMIT, ABSOLUTE_DOWNLOAD_LIMIT);
  const estimate = {
    endpoint: endpoint.toString(),
    status: head.status,
    contentType,
    contentLength,
    confirmationRequired: false,
    absoluteLimitBytes: effectiveLimit,
  };
  if (estimateOnly) return structuredResult({
    estimate,
    estimateAvailable: contentLength !== null,
    provenance: {
      endpoint: endpoint.toString(),
      retrievedAt: new Date().toISOString(),
      status: head.status,
      contentType,
      sourceBytes: 0,
    },
  });
  if (head.status >= 400 && head.status !== 405 && head.status !== 501) {
    throw new EposApiError(`EPOS preflight returned HTTP ${head.status}.`, {
      code: "PREFLIGHT_FAILED", endpoint: endpoint.toString(), status: head.status,
    });
  }
  if (contentLength !== null && contentLength > effectiveLimit) {
    throw new EposApiError("The estimated response exceeds the remaining study download budget.", {
      code: "DOWNLOAD_LIMIT_EXCEEDED", endpoint: endpoint.toString(), status: head.status,
    });
  }

  const response = await fetch(endpoint, { headers: { accept: query.format || "*/*" } });
  if (!response.ok) {
    throw new EposApiError(`EPOS execute returned HTTP ${response.status} ${response.statusText}.`, {
      endpoint: endpoint.toString(), status: response.status,
    });
  }
  const responseLength = Number(response.headers.get("content-length"));
  const totalLength = Number.isFinite(responseLength) && responseLength >= 0 ? responseLength : contentLength;
  if (totalLength !== null && totalLength > effectiveLimit) {
    throw new EposApiError("The response exceeds the remaining study download budget.", {
      code: "DOWNLOAD_LIMIT_EXCEEDED", endpoint: endpoint.toString(), status: response.status,
    });
  }

  const finalContentType = response.headers.get("content-type") || contentType;
  const finalName = outputFileName || generatedFileName(resourceId, finalContentType, query.format);
  const targetDirectory = outputDirectoryPath(outputDirectory);
  const filePath = join(targetDirectory, finalName);
  const previewChunks = [];
  let capturedPreviewBytes = 0;
  let downloadedBytes = 0;
  let file;
  try {
    await mkdir(targetDirectory, { recursive: true });
    file = await open(filePath, "w");
    if (!response.body) throw new EposApiError("EPOS response has no readable body.", { endpoint: endpoint.toString() });
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const writableBytes = Math.min(value.byteLength, effectiveLimit - downloadedBytes);
      const writablePart = value.slice(0, writableBytes);
      if (writablePart.byteLength) {
        await file.write(writablePart);
        downloadedBytes += writablePart.byteLength;
      }
      if (capturedPreviewBytes < previewBytes && writablePart.byteLength) {
        const part = writablePart.slice(0, Math.min(writablePart.byteLength, previewBytes - capturedPreviewBytes));
        previewChunks.push(part);
        capturedPreviewBytes += part.byteLength;
      }
      if (writableBytes < value.byteLength) {
        throw new EposApiError("The streaming response exceeded the remaining study download budget.", {
          code: "DOWNLOAD_LIMIT_EXCEEDED", endpoint: endpoint.toString(),
        });
      }
    }
  } catch (error) {
    await file?.close();
    file = undefined;
    if (downloadedBytes > 0) {
      const partialPath = partialFileName(filePath);
      let retainedFile = partialPath;
      await rename(filePath, partialPath).catch(async () => {
        retainedFile = undefined;
        await unlink(filePath).catch(() => {});
      });
      const failure = error instanceof EposApiError
        ? error
        : new EposApiError(error instanceof Error ? error.message : String(error), { endpoint: endpoint.toString() });
      failure.outputFile = retainedFile;
      failure.bytes = downloadedBytes;
      failure.complete = false;
      failure.datasetCompleteness = "partial";
      failure.pageCount = 1;
      failure.coverage = {
        requestedStart: query.startDate,
        requestedEnd: query.endDate,
        requestedBbox: query.bbox,
        verified: false,
      };
      throw failure;
    } else {
      await unlink(filePath).catch(() => {});
    }
    throw error;
  } finally {
    await file?.close();
  }

  const preview = isTextual(finalContentType)
    ? new TextDecoder().decode(Buffer.concat(previewChunks.map((chunk) => Buffer.from(chunk))))
    : undefined;
  const retrievedAt = new Date().toISOString();
  return structuredResult({
    endpoint: endpoint.toString(),
    status: response.status,
    contentType: finalContentType,
    bytes: downloadedBytes,
    outputFile: filePath,
    preview,
    truncated: downloadedBytes > capturedPreviewBytes,
    complete: true,
    transportComplete: true,
    datasetCompleteness: "not_verifiable",
    pageCount: 1,
    coverage: {
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      requestedBbox: query.bbox,
      verified: false,
    },
    retrievedAt,
    provenance: {
      endpoint: endpoint.toString(),
      retrievedAt,
      status: response.status,
      contentType: finalContentType,
      sourceBytes: downloadedBytes,
    },
  });
}));

const transport = new StdioServerTransport();
await server.connect(transport);
