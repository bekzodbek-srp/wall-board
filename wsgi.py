"""WSGI adapter, for running the wallboard on a host like PythonAnywhere.

`server.py` is a plain http.server application, not a WSGI one, so it cannot be
imported as `application` directly. Rather than fork the request handling — the
proxy's HTML rewriting is subtle and hard-won — this feeds each WSGI request
through the very same `Handler` and translates the response back.

On PythonAnywhere, point the web app's WSGI file at this:

    import sys
    path = '/home/wallboard/wall-board'
    if path not in sys.path:
        sys.path.insert(0, path)
    from wsgi import application          # noqa

Read the deployment notes in README.md first: a public wallboard is a very
different thing from a loopback one.
"""

from __future__ import annotations

import base64
import io
import os
import sys
import threading
from http.client import HTTPResponse

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

import server  # noqa: E402

# Set this to require a login. Without it the board — and the proxy behind it —
# is open to anyone who finds the URL. See README, "Putting it on the internet".
PASSWORD = os.environ.get("WALLBOARD_PASSWORD", "")
USERNAME = os.environ.get("WALLBOARD_USERNAME", "wallboard")

# Headers the host generates itself; passing ours through would duplicate them.
_HOST_HEADERS = {"server", "date", "connection", "transfer-encoding"}

_lock = threading.Lock()
_config_mtime: float | None = None


def _load_into_handler() -> None:
    config = server.load_config()
    if server.migrate_types(config) | server.migrate_layout(config):
        server.save_config(config)
    server.Handler.config = config
    server.Handler.allowed_origins = server.origins_of(config)


def _refresh_if_stale() -> None:
    """Re-read config.json when it changes on disk.

    A WSGI host runs several worker processes. A board saved by one of them
    would otherwise be invisible to the others until the app was reloaded, so
    each worker follows the file rather than trusting the copy it started with.
    """
    global _config_mtime
    try:
        mtime = os.path.getmtime(server.CONFIG_PATH)
    except OSError:
        mtime = None
    if mtime != _config_mtime:
        _config_mtime = mtime
        _load_into_handler()


class _Socket:
    """Just enough of a socket for BaseHTTPRequestHandler to talk to."""

    def __init__(self, request: bytes):
        self._incoming = io.BytesIO(request)
        self.outgoing = io.BytesIO()

    def makefile(self, mode="rb", *args, **kwargs):
        return self.outgoing if "w" in mode else self._incoming

    def sendall(self, data):            # http.server writes through this
        self.outgoing.write(data)

    def flush(self):
        pass

    def close(self):
        pass

    def shutdown(self, how=None):
        pass


class _ResponseSocket:
    def __init__(self, raw: bytes):
        self._raw = io.BytesIO(raw)

    def makefile(self, *args, **kwargs):
        return self._raw


def _raw_request(environ) -> bytes:
    """Rebuild the HTTP request the handler expects.

    The target is taken from REQUEST_URI when the host provides it, because
    PATH_INFO is percent-DECODED — and this app's paths carry a whole URL
    (`/proxy/https://host/page?q=1`), where decoding can change the meaning.
    """
    target = environ.get("REQUEST_URI") or environ.get("RAW_URI")
    if not target:
        target = environ.get("PATH_INFO", "/")
        query = environ.get("QUERY_STRING", "")
        if query:
            target = f"{target}?{query}"

    method = environ.get("REQUEST_METHOD", "GET")
    length = int(environ.get("CONTENT_LENGTH") or 0)
    body = environ["wsgi.input"].read(length) if length else b""

    lines = [f"{method} {target} HTTP/1.1"]
    seen_host = False
    for key, value in environ.items():
        if not key.startswith("HTTP_"):
            continue
        name = key[5:].replace("_", "-").title()
        if name.lower() == "host":
            seen_host = True
        if name.lower() in ("connection", "transfer-encoding", "keep-alive"):
            continue
        lines.append(f"{name}: {value}")
    if not seen_host:
        lines.append(f"Host: {environ.get('SERVER_NAME', 'localhost')}")
    if environ.get("CONTENT_TYPE"):
        lines.append(f"Content-Type: {environ['CONTENT_TYPE']}")
    lines.append(f"Content-Length: {len(body)}")
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


def _unauthorised(start_response):
    body = b"Authentication required."
    start_response("401 Unauthorized", [
        ("Content-Type", "text/plain; charset=utf-8"),
        ("Content-Length", str(len(body))),
        ("WWW-Authenticate", 'Basic realm="Wallboard", charset="UTF-8"'),
    ])
    return [body]


def _authorised(environ) -> bool:
    if not PASSWORD:
        return True                     # no password set: open, as warned
    header = environ.get("HTTP_AUTHORIZATION", "")
    if not header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(header.split(None, 1)[1]).decode("utf-8")
        user, _, secret = decoded.partition(":")
    except Exception:
        return False
    # Compared without short-circuiting on the first wrong character.
    from hmac import compare_digest
    return compare_digest(user, USERNAME) and compare_digest(secret, PASSWORD)


def application(environ, start_response):
    if not _authorised(environ):
        return _unauthorised(start_response)

    with _lock:
        _refresh_if_stale()
        sock = _Socket(_raw_request(environ))
        # A fresh handler per request; it reads the request and writes the reply
        # into the fake socket rather than a real one.
        server.Handler(sock, (environ.get("REMOTE_ADDR", "127.0.0.1"), 0), None)
        raw = sock.outgoing.getvalue()

    parsed = HTTPResponse(_ResponseSocket(raw),
                          method=environ.get("REQUEST_METHOD", "GET"))
    parsed.begin()
    body = parsed.read()

    headers = [(k, v) for k, v in parsed.getheaders()
               if k.lower() not in _HOST_HEADERS]
    if not any(k.lower() == "content-length" for k, _ in headers):
        headers.append(("Content-Length", str(len(body))))

    start_response(f"{parsed.status} {parsed.reason or ''}".strip(), headers)
    return [body]
