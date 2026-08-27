"""URL accessibility checker API with live streaming results."""

from __future__ import annotations

import asyncio
import json
import shutil
import socket
import time
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="OSI URL Checker", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Equivalent of: curl -s -o /dev/null -w "%{http_code}\n" <url>
REQUEST_TIMEOUT = 15.0
MAX_URLS = 20000
# nmap -sV is slow; keep this modest for large batches
MAX_CONCURRENCY = 8
# High-interest ports from common exposure checklist (+ 443 for HTTPS)
NMAP_PORTS = (
    "21,22,23,25,53,80,110,139,443,445,1433,1521,3306,3389,5432,5900,6379,8080,8443"
)
NMAP_BIN = shutil.which("nmap")


class CheckRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=MAX_URLS)


class UrlResult(BaseModel):
    url: str
    ok: bool
    status_code: int | None = None
    accessible: bool
    error: str | None = None
    response_time_ms: float | None = None
    ip_address: str | None = None
    open_ports: list[int] | None = None
    server: str | None = None


def normalize_url(raw: str) -> str | None:
    url = raw.strip()
    if not url:
        return None
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    parsed = urlparse(url)
    if not parsed.netloc:
        return None
    return url


async def resolve_ip(hostname: str | None) -> str | None:
    if not hostname:
        return None
    try:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(
            hostname, None, family=socket.AF_INET, type=socket.SOCK_STREAM
        )
    except socket.gaierror:
        return None
    return infos[0][4][0] if infos else None


def parse_nmap_xml(xml_text: str) -> tuple[list[int], str | None]:
    """Return (open_ports, server label) from nmap XML."""
    root = ET.fromstring(xml_text)
    ports: list[int] = []
    # product -> has_ssl
    products: dict[str, bool] = {}

    for port in root.findall(".//port"):
        state = port.find("state")
        if state is None or state.get("state") != "open":
            continue
        port_id = port.get("portid")
        if not port_id:
            continue
        ports.append(int(port_id))

        service = port.find("service")
        if service is None:
            continue
        product = (service.get("product") or "").strip()
        name = (service.get("name") or "").strip()
        version = (service.get("version") or "").strip()
        tunnel = (service.get("tunnel") or "").strip()

        if product:
            label = f"{product} {version}".strip() if version else product
        elif name:
            label = name
        else:
            continue

        products[label] = products.get(label, False) or tunnel == "ssl"

    ports.sort()
    if not products:
        return ports, None

    parts = [
        f"{name} (ssl)" if has_ssl else name for name, has_ssl in products.items()
    ]
    return ports, "; ".join(parts)


async def run_nmap(host: str) -> tuple[list[int] | None, str | None, str | None]:
    """Scan high-interest ports with service detection (-sV).

    Returns (open_ports, server, error).
    """
    if not NMAP_BIN:
        return None, None, "nmap not installed"

    proc = await asyncio.create_subprocess_exec(
        NMAP_BIN,
        "-Pn",
        "-T4",
        "-p",
        NMAP_PORTS,
        "-sV",
        "--version-light",
        "--open",
        "--host-timeout",
        "45s",
        "-oX",
        "-",
        host,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode not in (0, 1):
        # nmap uses 1 when hosts are down / no ports; still may have XML
        err = stderr.decode(errors="replace").strip() or f"nmap exit {proc.returncode}"
        text = stdout.decode(errors="replace")
        if "<nmaprun" not in text:
            return None, None, err

    text = stdout.decode(errors="replace")
    if "<nmaprun" not in text:
        return None, None, "nmap returned no XML"

    try:
        ports, server = parse_nmap_xml(text)
    except ET.ParseError as exc:
        return None, None, f"nmap XML parse error: {exc}"

    return ports, server, None


async def http_check(
    client: httpx.AsyncClient, url: str
) -> tuple[int | None, str | None, str | None, str | None]:
    """Return (status_code, final_host, server_header, error)."""
    hostname = urlparse(url).hostname
    try:
        async with client.stream("GET", url) as response:
            status_code = response.status_code
            final_host = urlparse(str(response.url)).hostname or hostname
            server_header = response.headers.get("server")
        return status_code, final_host, server_header, None
    except httpx.TimeoutException:
        return None, hostname, None, "Request timed out"
    except httpx.RequestError as exc:
        return None, hostname, None, str(exc) or exc.__class__.__name__


async def check_one(client: httpx.AsyncClient, url: str) -> UrlResult:
    start = time.perf_counter()
    hostname = urlparse(url).hostname or ""

    (status_code, final_host, server_header, http_error), nmap_result = await asyncio.gather(
        http_check(client, url),
        run_nmap(hostname),
    )

    open_ports, nmap_server, nmap_error = nmap_result
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    ip_address = await resolve_ip(final_host or hostname)

    # Prefer nmap service product; fall back to HTTP Server header.
    server = nmap_server or server_header

    if status_code is not None:
        return UrlResult(
            url=url,
            ok=200 <= status_code < 400,
            status_code=status_code,
            accessible=True,
            response_time_ms=elapsed_ms,
            ip_address=ip_address,
            open_ports=open_ports,
            server=server,
            error=nmap_error if open_ports is None and nmap_error else None,
        )

    return UrlResult(
        url=url,
        ok=False,
        accessible=False,
        error=http_error or nmap_error or "Request failed",
        response_time_ms=elapsed_ms,
        ip_address=ip_address,
        open_ports=open_ports,
        server=server,
    )


def ndjson(event: dict) -> str:
    return json.dumps(event, separators=(",", ":")) + "\n"


@app.get("/health")
async def health() -> dict[str, str | bool]:
    return {"status": "ok", "nmap": bool(NMAP_BIN)}


@app.post("/api/check")
async def check_urls_stream(body: CheckRequest) -> StreamingResponse:
    """Stream one NDJSON event per URL as checks complete."""

    rows: list[tuple[str, str | None]] = []
    seen: set[str] = set()

    for raw in body.urls:
        url = normalize_url(raw)
        if url is None:
            rows.append((raw.strip() or "(empty)", None))
            continue
        if url in seen:
            continue
        seen.add(url)
        rows.append((url, url))

    async def generate() -> AsyncIterator[str]:
        yield ndjson({"type": "start", "total": len(rows), "nmap": bool(NMAP_BIN)})

        for index, (display, normalized) in enumerate(rows):
            if normalized is None:
                yield ndjson(
                    {
                        "type": "result",
                        "index": index,
                        "result": UrlResult(
                            url=display,
                            ok=False,
                            accessible=False,
                            error="Invalid URL",
                        ).model_dump(),
                    }
                )

        to_check = [(i, u) for i, (_, u) in enumerate(rows) if u is not None]
        if not to_check:
            yield ndjson({"type": "done"})
            return

        semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=MAX_CONCURRENCY + 5,
                max_keepalive_connections=MAX_CONCURRENCY,
            ),
        ) as client:

            async def check_indexed(index: int, url: str) -> tuple[int, UrlResult]:
                async with semaphore:
                    return index, await check_one(client, url)

            tasks = [asyncio.create_task(check_indexed(i, u)) for i, u in to_check]
            try:
                for finished in asyncio.as_completed(tasks):
                    index, result = await finished
                    yield ndjson(
                        {
                            "type": "result",
                            "index": index,
                            "result": result.model_dump(),
                        }
                    )
            except asyncio.CancelledError:
                for task in tasks:
                    task.cancel()
                raise

        yield ndjson({"type": "done"})

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
