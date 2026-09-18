---
name: epos-fdsn-earthquakes
description: Use for querying or inspecting earthquake events through the bundled FDSN service and supported datacenters. Do not use for general EPOS catalogue discovery.
license: CC-BY-4.0
---

# FDSN earthquake events

Load `seismology` with `epos_load_tools`, then use `fdsn_query_earthquakes` for event searches and the detail operation for a selected event.

Collect missing scientific filters in the workflow's single initial question block. Preserve exact time, spatial, depth, magnitude, ordering, and datacenter choices without inventing them. Resolve a named area from authoritative metadata when possible; ask for one center or reference only if it remains ambiguous. Pass `limit` only when the researcher explicitly requests a count; otherwise the adapter partitions the requested time range, deduplicates events and verifies coverage before declaring the JSONL complete.

Event identifiers are opaque and provider-specific. Copy them exactly and never reuse an identifier with a different datacenter.

Report datacenter, filters, record count, verified coverage, shard/page counts, examples, absolute output path, completeness, and provenance. A `.partial.jsonl` file is incomplete and must never be presented as a complete dataset. Continue to preliminary inspection and visualization after the confirmed plan without treating them as scientific validation.
