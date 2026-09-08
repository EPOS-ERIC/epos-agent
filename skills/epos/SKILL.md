---
name: epos
description: Operational guidance for using the EPOS Platform catalogue, Resources Service, API Gateway, and specialist scientific services. Use for EPOS data discovery, service descriptions, parameter validation, execution, and provenance reporting.
license: CC-BY-4.0
---

# EPOS Platform Skill

## Purpose
Use this skill when a task involves the European Plate Observing System (EPOS), EPOS Platform, ICS-C services, TCS/domain data services, or geoscience service discovery/execution.

## Architecture Notes
- The EPOS Platform integrates distributed solid-Earth science data/services through a central catalogue and API Gateway.
- EPOS metadata is based on EPOS-DCAT-AP concepts: data products/distributions, web services, organisations/providers, categories/science domains, service parameters, formats, and provenance.
- The Resources Service is the first registry for discovery. Do not preload or memorize dynamic catalogue content.
- The API Gateway exposes catalogue endpoints such as `/resources/search`, `/resources/details/{instance_id}`, parameter linkage, and `/execute/{instance_id}` for external service access.
- Scientific domains/TCS include areas such as seismology, volcanology, GNSS/geodesy, geological information and modelling, anthropogenic hazards, satellite data, geomagnetic observations, and related solid-Earth research infrastructure.

## Operating Procedure
1. Search with `epos_search_resources` using the user's topic, time, bbox, keywords, domains, service types, or organisations.
2. Present a concise shortlist with resource IDs, titles, providers, science domains, and available formats.
3. Before execution, call `epos_describe_resource` for the selected resource ID.
4. Use `epos_describe_service` when service parameters, endpoint, formats, linked entities, or documentation are needed.
5. Validate user parameters against `serviceParameters` and available formats. Respect required/read-only/default/enum/valuePattern metadata.
6. Execute only with `epos_execute_service` after validation. Use `useDefaults` only when explicitly appropriate.
7. Always report provenance: EPOS resource ID/metaId/uid when available, serviceName, provider(s), endpoint, parameters, retrieval timestamp, content type/source format, and whether results are raw data or interpretation.

## Parameter Guidance
- Dates may use ISO-8601 or the `valuePattern` shown in metadata.
- Bounding boxes should follow the EPOS `bbox` query string expected by the gateway when using generic search/execution.
- Service-specific parameters are passed through the generic gateway `params` JSON; include only parameters advertised by metadata unless the service documentation says otherwise.
- Required read-only parameters with defaults/enums should normally use the advertised default.

## Authentication
Most discovery endpoints are public. Some restricted endpoints require authentication. If a request returns 401/403, do not retry blindly; explain that authentication/authorization is required.

## Specialist Services
For earthquake-event questions, prefer the bundled FDSNWS Event MCP/service when available. It supports FDSN-compliant datacenters such as INGV, EMSC, GFZ, and USGS. Event IDs are provider-specific opaque identifiers and must be copied exactly from search results.

## EPOS Workspace
- Files generated for the user may be written only under `~/epos-agent/workspace/`.
- If a user asks to save outputs, place them there and report the exact path.
- Do not attempt writes outside that workspace.
- Use `epos_run_python` for Python execution. It runs with cwd `~/epos-agent/workspace/` and can return generated images inline when `outputImagePath` is set.
- Use `epos_show_image` to display an existing workspace PNG/JPEG/GIF/WebP in the chat/TUI.

## Do Not
- Do not invent missing services or parameters.
- Do not duplicate large dynamic catalogue content into the answer.
- Do not hide failed requests; include errors and endpoints.
- Do not conflate model interpretation with retrieved EPOS data.