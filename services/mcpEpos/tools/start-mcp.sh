#!/bin/bash
# Start the EPOS MCP HTTP server for LM Studio
# Run this BEFORE opening LM Studio

cd "$(dirname "$0")/.."

PORT=${EPOS_MCP_PORT:-8765}

echo "Starting EPOS MCP server on port $PORT..."
exec python3 tools/epos_mcp_http.py --port "$PORT"
