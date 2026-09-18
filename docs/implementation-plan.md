# EPOS Agent v0.2 architecture

1. Pi owns provider/model selection. The launcher adds `EPOS_PROVIDER`, `EPOS_MODEL` or `EPOS_THINKING` only when explicitly configured; any Pi model with tool calling is supported.
2. Every turn starts with only `read` and `epos_load_tools`. The model invokes the router to activate a dedicated catalogue-search, software-search or operational capability group, which is replaced when another group is needed and reset on the next turn.
3. EPOS and FDSN MCP processes are lazy: they start on their first tool call and stop with the session.
4. The EPOS MCP exposes standard typed tools with `structuredContent`: `search_resources`, `search_software`, `describe_resource`, `describe_software`, `describe_service` and `execute_service`.
5. Search output is fetched across all catalogue pages, deduplicated and reduced to compact candidates. Chat shows only relevant titles grouped by scientific role; raw facets remain outside model context.
6. `execute_service` validates normalized metadata parameters, streams the response into the active study bundle, and reports transport and scientific completeness separately. A single plan confirmation and a cumulative 1 GiB study budget replace the 50 MB threshold.
7. FDSN queries honor an explicit limit. Without one, the adapter partitions the time range until every shard is below the provider cap, deduplicates IDs and verifies temporal boundaries. Intermediate or unverifiable results produce a declared `.partial.jsonl` file.
8. Provenance is stored under `logs/provenance`; provider-neutral token usage is appended to `logs/token-usage.jsonl` without prompts or scientific payloads.
9. Sessions, cache, logs and generated study bundles remain local and excluded from Git. Each bundle contains data, figures, parameters, provenance, `analysis.py`, a notebook, a manifest and README.
