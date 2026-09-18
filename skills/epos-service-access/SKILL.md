---
name: epos-service-access
description: Use after an EPOS catalogue result is selected to inspect resource or service metadata, validate parameters, estimate size, download data, and report provenance. Do not use for initial catalogue discovery.
license: CC-BY-4.0
---

# EPOS service access

Load `description` with `epos_load_tools` to inspect a selected resource or service. Load `download` only when preparing or executing access to its data.

Use the selected EPOS ID unchanged. Inspect normalized service parameters before execution and preserve the researcher's temporal, spatial, format, and service-specific filters. Reuse confirmed study dimensions. Ask again only when an unresolved scientific ambiguity prevents a valid request; do not ask for an operational value that authoritative metadata already supplies.

Before downloading, add the available estimate, format, interval, area, service, and provider to the combined study plan. Distinguish estimates from known values. After the researcher confirms that plan once, download without another size prompt; the cumulative raw-data budget is 1 GiB per study.

`epos_execute_service` saves the full transport response in the active study bundle and returns only a bounded preview. Report transport completeness and scientific dataset completeness separately, together with bytes or record count, format, output path, source endpoint, retrieval time, and provenance. Keep automated observations separate from scientific validation.

Use `analysis` or `workspace` only when the user asks to inspect or transform saved output. Files and Python execution remain restricted to the EPOS workspace.
