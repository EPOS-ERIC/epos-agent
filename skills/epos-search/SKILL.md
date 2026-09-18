---
name: epos-search
description: Use for discovering EPOS Platform datasets, distributions, providers, services, or catalogued software. Do not use for executing a selected service or querying earthquake events through FDSN.
license: CC-BY-4.0
---

# EPOS catalogue search

Treat the catalogue as dynamic. Load `catalog_search` with `epos_load_tools` for data, distributions, services, or providers; load `software_search` only for software.

Build a concise English catalogue query from the research request while preserving proper names, dates, bounding boxes, and confirmed filters. Use `q` for free text. Use `keywords` or service types only when their catalogue values are known; never invent filter values.

If the user names a provider, call `epos_search_organizations` first and pass the selected organization ID unchanged to `epos_search_resources`. Use a unique clear match; when several organizations are plausible, show the candidates and ask the researcher to choose.

The search adapter traverses all catalogue pages and returns compact candidates for internal ranking. Present only the titles of relevant services or datasets, grouped by scientific role, followed by one short explanation per group. Do not show internal EPOS IDs or a separate relevance paragraph for every item unless the researcher explicitly asks for technical details.

If a search is empty, make at most one broader retry by simplifying the free-text query or removing an optional filter. Report both attempts if it remains empty. Do not silently select, describe, or execute a result unless automatic selection was explicitly requested.

Use the active study context and ask for missing scientific details only in the workflow's single initial clarification block. Keep retrieved facts separate from interpretation and do not expose raw facets or catalogue payloads.
