---
name: epos-execute
description: Prepare and execute a selected EPOS distribution, including OGC services and converted output formats with pluginId/inputFormat. Use after EPOS discovery, not for FDSN earthquake queries.
---

# Execute EPOS distributions

Load `description` and call `epos_details` before preparing an execution. Treat its `available_formats` and `operations[].parameters` as authoritative; never guess a parameter name or a conversion ID.

Choose the output option that matches the requested scientific format. Pass its `format` to `epos_prepare_execute`; the MCP resolves the actual gateway value from the option `href` and automatically carries its `inputFormat` and `pluginId`. Do not put `format`, `inputFormat`, or `pluginId` inside `params`.

Build `params` as one JSON object using the exact declared service-parameter names. Preserve case, including names such as `MAP`. Empty optional values are allowed. Read-only parameters are service constants: normally retain their metadata defaults rather than asking the researcher for them.

OGC distributions use the `ogcexecute` route automatically. For `GetCapabilities`, provide `request: "GetCapabilities"`; the MCP supplies declared constants such as `service`, `version`, and provider-specific `MAP`. Inspect the returned capabilities before constructing `GetMap`, `GetFeature`, or `GetCoverage` parameters, and use only layers, CRS, extents, dimensions, and formats declared there.

For non-OGC distributions the MCP sends provider fields inside the gateway's single `params` query value. Converted formats are executed with the metadata-declared `inputFormat` and `pluginId` as separate gateway query parameters.

Call `epos_prepare_execute` first. If it returns reasons, correct only the reported fields or ask for missing required scientific values. After the study download plan has been confirmed, call `epos_execute` with the returned `plan_id`; set `confirm: true` when the plan itself requires it. Never reuse a plan ID from another session or distribution.

Do not estimate response size. Before confirmation, summarize only the selected distribution, exact parameters, output format and chosen analysis/plot. Search and metadata calls remain automatic; executing a service that returns scientific records is data acquisition and requires the study's single confirmation. Report byte and record counts only after acquisition, using measured values.

If an upstream distribution returns HTTP 401 or 403, report that its data were not downloaded and identify the distribution as access-restricted. Offer a minimal reproducible `curl` command using the declared download URL and `Authorization: Bearer "$EPOS_DATA_TOKEN"`, with the token supplied through an environment variable. Never request, print, hardcode, or write an access token to a notebook, script, artifact, or log; do not retry without credentials. Keep catalog metadata separate from downloaded data and mark the result as partial until the authenticated transfer succeeds.

Report completeness from the execution result without strengthening it. `transportComplete` describes receipt of that HTTP response only. Say that pagination exists only when `paginationDetected` is true and include `paginationEvidence`; false means “no pagination evidence detected”, not “the service is not paginated”. Preserve `scientificCompleteness` and `completenessReason` verbatim in meaning. Do not infer European or provider-wide coverage from a catalogue search, a single distribution, or a complete HTTP transfer.
