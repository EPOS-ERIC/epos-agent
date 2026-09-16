---
name: epos-fdsn-earthquakes
description: Use for querying or inspecting earthquake events through the bundled FDSN service and supported datacenters. Do not use for general EPOS catalogue discovery.
license: CC-BY-4.0
---

# FDSN earthquake events

Load `seismology` with `epos_load_tools`, then use `fdsn_query_earthquakes` for event searches and the detail operation for a selected event.

Concisely ask for missing scientific filters (e.g. timeframe, region, magnitude) if the request is vague. Preserve exact time, spatial, depth, magnitude, ordering, and datacenter choices without inventing them. Pass `limit` only when the researcher explicitly requests a count; otherwise the adapter follows all pages and writes the complete result as JSONL.

Event identifiers are opaque and provider-specific. Copy them exactly and never reuse an identifier with a different datacenter.

Report datacenter, filters, record count, examples, output path, completeness, and provenance. A `.partial.jsonl` file is incomplete and must never be presented as a complete dataset. Offer a preliminary inspection as the next step without treating it as scientific validation.
