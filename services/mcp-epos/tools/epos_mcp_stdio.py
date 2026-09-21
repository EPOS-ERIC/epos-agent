#!/usr/bin/env python3
"""Run the EPOS MCP server over stdio for the local EPOS Agent."""
from __future__ import annotations

import anyio

from epos_mcp_http import PRINCIPAL, configure_audit_logging, make_server


async def serve() -> None:
    principal = PRINCIPAL.set({"name": "epos-agent", "fingerprint": "local", "session": "local", "scopes": "admin"})
    try:
        await make_server("full").run_stdio_async()
    finally:
        PRINCIPAL.reset(principal)


def main() -> None:
    configure_audit_logging()
    anyio.run(serve)


if __name__ == "__main__":
    main()
