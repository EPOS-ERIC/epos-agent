# EPOS Agent v0.2 architecture

1. Pi owns provider/model selection. The launcher adds `EPOS_PROVIDER`, `EPOS_MODEL` or `EPOS_THINKING` only when explicitly configured; any Pi model with tool calling is supported.
2. Every turn starts with only `read` and `epos_load_tools`. The model invokes the router to activate a dedicated catalogue-search, software-search or operational capability group, which is replaced when another group is needed and reset on the next turn.
3. EPOS and FDSN MCP processes are lazy: they start on their first tool call and stop with the session.
4. The EPOS MCP exposes standard typed tools with `structuredContent`: `search_resources`, `search_software`, `describe_resource`, `describe_software`, `describe_service` and `execute_service`.
5. Search output is locally paginated into at most five compact cards. Every card in the current page is shown to the researcher; later pages are fetched only on request. Raw facets remain outside model context.
6. `execute_service` validates normalized metadata parameters, streams the entire response into the workspace, and returns only size, format, path, preview and provenance. The 50 MB confirmation and 1 GB refusal remain enforced.
7. FDSN queries honor an explicit limit. Without one, the adapter follows all pages into JSONL and exposes at most five samples to the model. Intermediate failures produce a declared `.partial.jsonl` file.
8. Provenance is stored under `logs/provenance`; provider-neutral token usage is appended to `logs/token-usage.jsonl` without prompts or scientific payloads.
9. Sessions, cache, logs and generated datasets remain local and excluded from Git.
