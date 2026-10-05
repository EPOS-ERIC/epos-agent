---
name: epos-fdsn-earthquakes
description: Use for querying or inspecting earthquake events through the bundled FDSN service and supported datacenters. Do not use for general EPOS catalogue discovery.
license: CC-BY-4.0
---

# FDSN earthquake events

Use `epos_manage_study(action="prepare")` to include a request with tool `epos_fdsnws_event_call` and arguments `{toolName: "fdsn_query_earthquakes", arguments: {...}}`, specifying dates and datacenter. Detail requests also belong in the plan and require an observed event ID. `action="download"` obtains user-interface approval and executes all planned sources, including FDSN. Never fetch observations before approval, even for a small preview.

Collect missing scientific filters in the workflow's single initial question block. Preserve exact time, spatial, depth, magnitude, ordering, and datacenter choices without inventing them. Resolve a named area from authoritative metadata when possible; If a requested area is ambiguous and cannot be resolved (e.g., "Extended Etna"), DO NOT directly ask for a latitude/longitude pair. Instead, propose these 3 options to the user:
1. Let the agent propose a known point as the center.
2. Find and use the seismic event with the highest relevance in the catalog as the center.
3. Manually provide the latitude and longitude coordinates.

Pass `limit` ONLY when the researcher explicitly requests a maximum count. NEVER do a "partial" or "preview" download first, and NEVER attempt to manually chunk the time interval. The tool ALREADY automatically handles pagination, dense intervals, and deduplication internally to get all events in one go. Just call the tool with the full time range requested.

Event identifiers are opaque and provider-specific. Copy them exactly and never reuse an identifier with a different datacenter.

**Workflow ordering:** 
DO NOT mix visualization proposals (plots, maps) with data acquisition!
FIRST download and verify the FDSN seismic data, AND ONLY THEN (based on the records actually found) propose analysis and plot options.

Report datacenter, filters, record count, verified coverage, shard/page counts, examples, absolute output path, completeness, and provenance. A `.partial.jsonl` file is incomplete and must never be presented as a complete dataset. Continue to preliminary inspection and visualization after the confirmed plan without treating them as scientific validation.
