# EPOS Agent v0.2 architecture

1. Pi owns provider/model selection. The launcher adds `EPOS_PROVIDER`, `EPOS_MODEL` or `EPOS_THINKING` only when explicitly configured; any Pi model with tool calling is supported.
2. Every turn starts with only `read` and `epos_load_tools`. The model invokes the router to activate a dedicated catalogue-search or operational capability group, which is replaced when another group is needed and reset on the next turn.
3. The EPOS MCP starts and completes its handshake with the agent session, avoiding first-call races and preserving cached search/plan IDs. FDSN remains lazy; both stop with the session.
4. The bundled Python EPOS MCP is the primary source for EPOS discovery, metadata and downloads and exposes standard typed tools with `structuredContent`.
5. Search output is fetched across all catalogue pages, deduplicated and reduced to compact candidates. Chat shows only relevant titles grouped by scientific role; raw facets remain outside model context.
6. EPOS execution uses `epos_prepare_execute` followed by `epos_execute`; successful local artifacts are copied into the active study bundle. The execution path still needs end-to-end fixes, tracked in `PROJECT_STATUS.md`.
7. FDSN queries honor an explicit limit. Without one, the adapter partitions the time range until every shard is below the provider cap, deduplicates IDs and verifies temporal boundaries. Intermediate or unverifiable results produce a declared `.partial.jsonl` file.
8. Provenance is stored under `logs/provenance`; provider-neutral token usage is appended to `logs/token-usage.jsonl` without prompts or scientific payloads.
9. Sessions, cache, logs and generated study bundles remain local and excluded from Git. Each bundle contains data, figures, parameters, provenance, `analysis.py`, a notebook, a manifest and README.
