"""Compact, model-oriented views of EPOS gateway responses."""

from __future__ import annotations

from typing import Any


def _distributions(value: Any) -> list[dict[str, Any]]:
    """Collect distributions from the nested search response tree."""
    if not isinstance(value, dict):
        return []

    found: list[dict[str, Any]] = []
    items = value.get("distributions")
    if isinstance(items, list):
        found.extend(item for item in items if isinstance(item, dict))

    children = value.get("children")
    if isinstance(children, list):
        for child in children:
            found.extend(_distributions(child))
    return found


def normalized_candidates(payload: Any) -> list[dict[str, Any]]:
    """Return every unique distribution in a search payload in response order."""
    root = payload.get("results", {}) if isinstance(payload, dict) else {}
    all_candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in _distributions(root):
        distribution_id = item.get("id")
        if not isinstance(distribution_id, str) or distribution_id in seen:
            continue
        seen.add(distribution_id)

        provider = item.get("dataServiceProvider")
        provider_name = (
            provider.get("dataProviderLegalName")
            if isinstance(provider, dict)
            else None
        )
        formats = item.get("availableFormats")
        available_formats = (
            [
                entry.get("format")
                for entry in formats
                if isinstance(entry, dict) and isinstance(entry.get("format"), str)
            ]
            if isinstance(formats, list)
            else []
        )

        all_candidates.append(
            {
                "distribution_id": distribution_id,
                "title": item.get("title"),
                "provider": provider_name.strip()
                if isinstance(provider_name, str)
                else provider_name,
                "formats": sorted({item.strip().lower() for item in available_formats}),
                "description": item.get("description"),
                "status": str(item.get("status", "")).strip().lower(),
                "executable": bool(
                    item.get("serviceParameters")
                    or item.get("relatedDataProducts")
                    or item.get("serviceEndpoint")
                ),
            }
        )
    return all_candidates


def summarize_candidates(
    candidates: list[dict[str, Any]],
    limit: int = 12,
    offset: int = 0,
    description_limit: int | None = None,
) -> dict[str, Any]:
    """Return a compact, pageable window of normalized candidates."""
    window = candidates[offset : offset + limit]
    if description_limit is not None:
        window = [
            {
                **candidate,
                "description": candidate["description"][:description_limit]
                if isinstance(candidate.get("description"), str)
                else candidate.get("description"),
            }
            for candidate in window
        ]
    next_offset = offset + len(window)
    return {
        "total_candidates": len(candidates),
        "offset": offset,
        "returned_candidates": len(window),
        "next_offset": next_offset if next_offset < len(candidates) else None,
        "candidates": window,
    }


def summarize_search(payload: Any, limit: int = 12, offset: int = 0) -> dict[str, Any]:
    """Return a compact, pageable window of all unique search distributions."""
    return summarize_candidates(normalized_candidates(payload), limit, offset)


def _operation_containers(value: Any) -> list[dict[str, Any]]:
    """Find metadata objects that declare executable service operations."""
    if isinstance(value, list):
        return [
            container for item in value for container in _operation_containers(item)
        ]
    if not isinstance(value, dict):
        return []

    found = [value] if isinstance(value.get("operations"), list) else []
    return found + [
        container
        for item in value.values()
        for container in _operation_containers(item)
    ]


def summarize_details(payload: Any) -> dict[str, Any]:
    """Extract formats and declared execution parameters from distribution details."""
    if not isinstance(payload, dict):
        return {"operations": []}

    formats = payload.get("availableFormats")
    available_formats = (
        [
            {
                key: entry[key]
                for key in (
                    "format",
                    "label",
                    "href",
                    "originalFormat",
                    "inputFormat",
                    "pluginId",
                    "type",
                )
                if key in entry
            }
            for entry in formats
            if isinstance(entry, dict)
        ]
        if isinstance(formats, list)
        else []
    )

    def compact_parameters(declared: Any) -> list[dict[str, Any]]:
        parameters = []
        if isinstance(declared, list):
            for parameter in declared:
                if not isinstance(parameter, dict) or not isinstance(
                    parameter.get("name"), str
                ):
                    continue
                parameters.append(
                    {
                        key: parameter[key]
                        for key in (
                            "name",
                            "property",
                            "label",
                            "required",
                            "type",
                            "defaultValue",
                            "value",
                            "readOnlyValue",
                            "minValue",
                            "maxValue",
                            "enumValue",
                            "multipleValue",
                            "valuePattern",
                        )
                        if key in parameter
                    }
                )
        return parameters

    operations: list[dict[str, Any]] = []
    direct_parameters = compact_parameters(payload.get("serviceParameters"))
    if direct_parameters:
        operations.append(
            {
                "method": payload.get("method"),
                "endpoint": payload.get("endpoint") or payload.get("serviceEndpoint"),
                "documentation": payload.get("serviceDocumentation"),
                "name": payload.get("serviceName"),
                "parameters": direct_parameters,
            }
        )

    for container in _operation_containers(payload):
        for operation in container["operations"]:
            if not isinstance(operation, dict):
                continue
            operations.append(
                {
                    key: operation[key]
                    for key in ("method", "endpoint", "documentation")
                    if key in operation
                }
                | {"parameters": compact_parameters(operation.get("serviceParameters"))}
            )

    return {
        "distribution_id": payload.get("id"),
        "title": payload.get("title"),
        "description": payload.get("description"),
        "available_formats": available_formats,
        "operations": operations,
    }


def declared_parameters(payload: Any) -> list[dict[str, Any]]:
    """Collect direct and nested service parameter declarations, once per name."""
    summary = summarize_details(payload)
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for operation in summary["operations"]:
        for parameter in operation["parameters"]:
            name = parameter.get("name")
            if isinstance(name, str) and name not in seen:
                seen.add(name)
                result.append(parameter)
    return result


def summarize_organizations(payload: Any, limit: int = 20) -> dict[str, Any]:
    """Return compact organization identifiers without exposing the raw response."""
    organizations: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        identifier = (
            value.get("id") or value.get("identifier") or value.get("organizationId")
        )
        name = (
            value.get("name")
            or value.get("legalName")
            or value.get("dataProviderLegalName")
            or value.get("label")
        )
        if isinstance(identifier, str) and identifier not in seen:
            seen.add(identifier)
            organizations.append(
                {
                    key: value[key]
                    for key in (
                        "id",
                        "identifier",
                        "organizationId",
                        "name",
                        "legalName",
                        "dataProviderLegalName",
                        "label",
                        "acronym",
                        "country",
                        "type",
                    )
                    if key in value
                }
            )
            if name is not None and not any(
                key in organizations[-1]
                for key in ("name", "legalName", "dataProviderLegalName", "label")
            ):
                organizations[-1]["name"] = name
        for child in value.values():
            if isinstance(child, (dict, list)):
                visit(child)

    visit(payload)
    return {
        "organization_count": len(organizations),
        "organizations": organizations[:limit],
    }
