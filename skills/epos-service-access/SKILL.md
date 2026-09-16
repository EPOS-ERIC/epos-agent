---
name: epos-service-access
description: Use after an EPOS catalogue result is selected to inspect resource or service metadata, validate parameters, estimate size, download data, and report provenance. Do not use for initial catalogue discovery.
license: CC-BY-4.0
---

# EPOS service access

Load `description` with `epos_load_tools` to inspect a selected resource or service. Load `download` only when preparing or executing access to its data.

Use the selected EPOS ID unchanged. Inspect normalized service parameters before execution and preserve the researcher's temporal, spatial, format, and service-specific filters. If key scientific dimensions are omitted or ambiguous, concisely ask the researcher 1-3 targeted questions to elicit their intent before proceeding; never invent parameters or guess their intent.

Before downloading, report the available estimate, format, interval, area, service, and provider. Distinguish estimates from known values. Downloads over 50 MB require explicit confirmation and responses over 1 GB are refused.

`epos_execute_service` saves the complete response in the EPOS workspace and returns only a bounded preview. Report completeness, bytes or record count, format, output path, source endpoint, retrieval time, and provenance. Keep automated observations separate from scientific validation.

Use `analysis` or `workspace` only when the user asks to inspect or transform saved output. Files and Python execution remain restricted to the EPOS workspace.
