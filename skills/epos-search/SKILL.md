---
name: epos-search
description: Use for discovering EPOS Platform datasets, distributions, providers, services, or catalogued software. Do not use for executing a selected service or querying earthquake events through FDSN.
license: CC-BY-4.0
---

# EPOS catalogue search

Treat the catalogue as dynamic. Load `catalog_search` with `epos_load_tools` for data, distributions, services, or providers; load `software_search` only for software.

Build a concise English catalogue query from the research request while preserving proper names, dates, bounding boxes, and confirmed filters. Use `q` for free text. Use `keywords` or service types only when their catalogue values are known; never invent filter values.

If the user names a provider, call `epos_search_organizations` first and pass the selected organization ID unchanged to `epos_search_resources`. Use a unique clear match; when several organizations are plausible, show the candidates and ask the researcher to choose.

Search returns at most five compact cards per page. Show every card in the current page with title, provider, EPOS ID, and a brief relevance interpretation grounded in its metadata. State how many matches remain and fetch another page only on request.

If a search is empty, make at most one broader retry by simplifying the free-text query or removing an optional filter. Report both attempts if it remains empty. Do not silently select, describe, or execute a result unless automatic selection was explicitly requested.

Concisely ask the researcher for their intent or missing scientific details (e.g., domain, region) if the query is too vague, rather than guessing. Keep retrieved facts separate from interpretation and do not expose raw facets or catalogue payloads.
