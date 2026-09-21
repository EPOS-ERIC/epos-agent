FROM python:3.13-slim

WORKDIR /app
RUN useradd --create-home --uid 10001 epos
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY tools/ ./tools/
RUN mkdir artifacts && chown -R epos:epos /app

USER epos
ENV EPOS_ARTIFACTS=/app/artifacts
EXPOSE 8765
# Health checks may use the legacy admin token. For token maps, monitor through nginx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python3 -c "import os, urllib.request; t=os.environ.get('EPOS_MCP_AUTH_TOKEN',''); r=urllib.request.Request('http://127.0.0.1:8765/healthz',headers={'Authorization':'Bearer '+t}); assert urllib.request.urlopen(r,timeout=4).status == 200"
CMD ["python3", "tools/epos_mcp_http.py", "--host", "0.0.0.0", "--port", "8765"]
