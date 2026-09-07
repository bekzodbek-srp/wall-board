#!/usr/bin/env python3
"""Wallboard -- a dashboard page that embeds OpenObserve panels alongside
whatever else you want to put on it.

Why a proxy is needed at all
----------------------------
OpenObserve cannot simply be dropped into an <iframe>:

  * it authenticates with an `auth_tokens` header, and browsers will not attach
    custom headers to an iframe *navigation*;
  * seeding localStorage in a normal tab does not help, because third-party
    iframe storage is partitioned;
  * it serves X-Frame-Options / CSP frame-ancestors, which forbid framing.

So this serves the page and reverse-proxies the upstream on the same origin:
the proxy attaches the auth header, drops the framing headers, and rewrites the
framed document so its own fetch/XHR calls come back through the proxy.

The technique is lifted from ../yodeckjon/server.py, generalised to arbitrary
origins (including http and non-default ports) and with credentials moved out
of the source file.

Usage:
    python3 server.py            # then open http://localhost:8770/
"""

from __future__ import annotations

import concurrent.futures
import gzip
import html
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
CONFIG_PATH = os.environ.get("WALLBOARD_CONFIG") or os.path.join(HERE, "config.json")
EXAMPLE_CONFIG = os.path.join(HERE, "config.example.json")

# Response headers we must not pass through: hop-by-hop ones, the encoding and
# length (we may have rewritten the body), and -- the whole point -- the headers
# that would stop the page being framed.
DROP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
    "content-encoding", "content-length",
    "strict-transport-security",
    "content-security-policy", "content-security-policy-report-only",
    "x-content-security-policy", "x-frame-options",
}


# A widget family, and the kinds it may come in. The first kind is the default.
# The page's catalogue must agree with this; the server is the authority.
WIDGET_KINDS = {
    "clock": ("digital", "analog"),
    "traffic-light": (),
    "note": (),
    "calendar": ("month",),
    "carousel": (),
}
WIDGET_TYPES = set(WIDGET_KINDS)

# Families that used to be their own type. Converted on the way in rather than
# rejected, so a hand-edited config or a stale open page cannot 400 a save.
LEGACY_TYPES = {"rotator": "carousel", "iframe": "carousel"}
TYPES_VERSION = "families-v1"

# Per-page dwell for the rotator widget.
MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS = 1, 60, 10
MAX_PAGES = 40

# Widgets are placed freely, but the board must always fit one screen, so
# geometry is stored as FRACTIONS of the canvas (0..1) rather than pixels.
# A widget is then the same share of the board on a laptop as on a wall display.
MIN_FRAC = 0.03          # a widget may not shrink to nothing
LAYOUT_VERSION = "fractional"

# Nominal board width used when converting an old grid layout to coordinates.
LEGACY_CANVAS_W = 1200
LEGACY_GAP = 16


def load_config() -> dict:
    """The board.

    config.json is per-installation state -- it is rewritten every time a widget
    is moved -- so it is not in the repository. A fresh checkout is seeded from
    config.example.json the first time the server runs.
    """
    if not os.path.exists(CONFIG_PATH) and os.path.exists(EXAMPLE_CONFIG):
        shutil.copyfile(EXAMPLE_CONFIG, CONFIG_PATH)
        print(f"  created {os.path.basename(CONFIG_PATH)} from the example board", flush=True)
    with open(CONFIG_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def migrate_types(config: dict) -> bool:
    """Fold retired families into current ones. True if anything changed.

    `rotator` became `carousel`, and the standalone `iframe` panel is now a
    carousel holding one page -- which behaves identically, because a one-page
    carousel never rotates. Done at load rather than left to the first save, so
    a board that is only ever looked at still gets converted.
    """
    if config.get("types") == TYPES_VERSION:
        return False
    for tile in config.get("tiles", []):
        old = tile.get("type")
        if old not in LEGACY_TYPES:
            continue
        tile["type"] = LEGACY_TYPES[old]
        if old == "iframe":
            url = str(tile.pop("url", "") or "").strip()
            tile["pages"] = ([{"url": url, "seconds": DEFAULT_SECONDS}]
                             if re.match(r"^https?://", url, re.I) else [])
    config["types"] = TYPES_VERSION
    return True


def migrate_layout(config: dict) -> bool:
    """Bring any older layout up to fractional coordinates. True if changed.

    Two older shapes exist and both are converted here, in order:

    1. A CSS grid: integer `span` of `columns`, plus a pixel `height`. Laid out
       exactly as the grid would have rendered it at a nominal width.
    2. Absolute pixels: `x`/`y`/`w`/`h` on an unbounded canvas.

    Pixels become fractions by dividing through the board's own extent, so the
    whole arrangement is scaled to exactly fill one screen with every relative
    position and proportion preserved.
    """
    if config.get("layout") == LAYOUT_VERSION:
        return False
    tiles = config.get("tiles", [])
    if not tiles:
        config["layout"] = LAYOUT_VERSION
        config.pop("columns", None)
        return True

    if not all("x" in t and "w" in t for t in tiles):
        _grid_to_pixels(config, tiles)
    _pixels_to_fractions(tiles)
    config["layout"] = LAYOUT_VERSION
    config.pop("columns", None)
    return True


def _pixels_to_fractions(tiles: list) -> None:
    ref_w = max((t["x"] + t["w"]) for t in tiles) or 1
    ref_h = max((t["y"] + t["h"]) for t in tiles) or 1
    for tile in tiles:
        tile["x"] = round(tile["x"] / ref_w, 4)
        tile["y"] = round(tile["y"] / ref_h, 4)
        tile["w"] = round(tile["w"] / ref_w, 4)
        tile["h"] = round(tile["h"] / ref_h, 4)


def _grid_to_pixels(config: dict, tiles: list) -> None:
    columns = max(1, int(config.get("columns") or 2))
    gap = LEGACY_GAP
    col_w = (LEGACY_CANVAS_W - gap * (columns - 1)) / columns

    cursor, y, row_h = 0, 0, 0
    for tile in tiles:
        span = max(1, min(columns, int(tile.get("span") or 1)))
        height = max(100, min(6000, int(tile.get("height") or 320)))
        if cursor + span > columns:
            y += row_h + gap
            cursor, row_h = 0, 0
        tile["x"] = round(cursor * (col_w + gap))
        tile["y"] = y
        tile["w"] = round(span * col_w + (span - 1) * gap)
        tile["h"] = height
        tile.pop("span", None)
        tile.pop("height", None)
        row_h = max(row_h, height)
        cursor += span


def save_config(config: dict) -> None:
    """Write atomically: a half-written config.json would break the next start."""
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, CONFIG_PATH)


class Invalid(ValueError):
    """Rejected input from the page, reported back to it verbatim."""


def _clamp_int(value, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _kind_field(family: str, raw: dict) -> dict:
    """The tile's `kind`, if its family has any. Unknown kinds fall to the first."""
    kinds = WIDGET_KINDS.get(family, ())
    if not kinds:
        return {}
    wanted = str(raw.get("kind") or "").strip()
    return {"kind": wanted if wanted in kinds else kinds[0]}


def _clamp_frac(value, default: float) -> float:
    try:
        return round(max(0.0, min(1.0, float(value))), 4)
    except (TypeError, ValueError):
        return default


def validate_config(incoming: dict, previous: dict) -> dict:
    """Sanitise what the page sends before it becomes the config on disk.

    The page is the only client, but it is still input: a bad `columns` or a
    non-http tile url would either break the grid or point the proxy somewhere
    unintended, so everything is clamped or rejected here rather than trusted.
    """
    if not isinstance(incoming, dict):
        raise Invalid("expected a JSON object")

    tiles_in = incoming.get("tiles")
    if not isinstance(tiles_in, list):
        raise Invalid("`tiles` must be a list")

    seen: set[str] = set()
    tiles = []
    for index, raw in enumerate(tiles_in):
        if not isinstance(raw, dict):
            raise Invalid(f"tile {index} is not an object")

        kind = LEGACY_TYPES.get(raw.get("type"), raw.get("type"))
        if kind not in WIDGET_TYPES:
            raise Invalid(
                f"tile {index} has unknown type {kind!r}; "
                f"expected one of {', '.join(sorted(WIDGET_TYPES))}"
            )

        tile_id = str(raw.get("id") or f"{kind}-{index}")
        while tile_id in seen:
            tile_id += "-2"
        seen.add(tile_id)

        # Fractions of the board, and never spilling off it: the board has to
        # fit one screen, so x + w and y + h may not exceed 1.
        width = max(MIN_FRAC, _clamp_frac(raw.get("w"), 0.4))
        height = max(MIN_FRAC, _clamp_frac(raw.get("h"), 0.4))
        x = min(_clamp_frac(raw.get("x"), 0.0), round(1.0 - width, 4))
        y = min(_clamp_frac(raw.get("y"), 0.0), round(1.0 - height, 4))
        tile = {
            "id": tile_id,
            "type": kind,
            **_kind_field(kind, raw),
            "title": str(raw.get("title") or "").strip() or kind,
            "x": max(0.0, x),
            "y": max(0.0, y),
            "w": width,
            "h": height,
        }

        if kind == "carousel":
            # A bad row is dropped rather than raised: one `raise Invalid` 400s
            # the whole POST, and the page then reverts every tile, throwing
            # away unrelated drag/resize work done in the same session.
            pages = []
            for entry in (raw.get("pages") or [])[:MAX_PAGES]:
                if not isinstance(entry, dict):
                    continue
                url = str(entry.get("url") or "").strip()
                if not re.match(r"^https?://", url, re.I):
                    continue
                seconds = entry.get("seconds")
                # _clamp_int(0, 1, 60, 10) is 1, not 10 -- it only falls back to
                # the default on a type error. An empty box must mean 10s.
                if seconds in (None, "", 0, "0"):
                    seconds = DEFAULT_SECONDS
                pages.append({
                    "url": url,
                    "seconds": _clamp_int(seconds, MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS),
                    # A direct page is fetched by the browser, not by us.
                    "direct": bool(entry.get("direct")),
                })
            # An absorbed iframe tile arrives carrying a bare `url` instead.
            if not pages and re.match(r"^https?://", str(raw.get("url") or ""), re.I):
                pages = [{"url": str(raw["url"]).strip(), "seconds": DEFAULT_SECONDS}]
            tile["pages"] = pages
            refresh = raw.get("refreshMinutes")
            if refresh not in (None, "", 0):
                tile["refreshMinutes"] = _clamp_int(refresh, 1, 1440, 5)

        elif kind == "clock":
            tile["timezone"] = str(raw.get("timezone") or "America/New_York")
            tile["label"] = str(raw.get("label") or "")

        elif kind == "calendar":
            tile["timezone"] = str(raw.get("timezone") or "America/New_York")
            # 1 = weeks start on Monday, 0 = Sunday.
            tile["weekStart"] = _clamp_int(raw.get("weekStart"), 0, 1, 1)

        elif kind == "note":
            tile["text"] = str(raw.get("text") or "")

        tiles.append(tile)

    merged = {
        **previous,
        "layout": LAYOUT_VERSION,
        "types": TYPES_VERSION,
        "title": str(incoming.get("title") or previous.get("title") or "Wallboard"),
        "timezone": str(incoming.get("timezone") or previous.get("timezone") or "America/New_York"),
        "timezoneLabel": str(incoming.get("timezoneLabel", previous.get("timezoneLabel", ""))),
        "tiles": tiles,
    }
    merged.pop("columns", None)
    return merged


def egress_proxy() -> str:
    """The proxy this host forces outbound traffic through, if any."""
    proxies = urllib.request.getproxies()
    return proxies.get("https") or proxies.get("http") or ""


def unreachable_notice(origin: str, exc: Exception) -> tuple[str, str]:
    """Title and detail for a failed upstream fetch.

    Worth distinguishing: a refused CONNECT means *this host* is not allowed out,
    which says nothing about whether the upstream is up. Reporting that as
    "start the service" sends people to debug a machine that is running fine.
    """
    text = str(exc)
    proxy = egress_proxy()
    if "tunnel connection failed" in text.lower():
        return (
            "This host is not allowed to reach that site",
            f"The wallboard server cannot open a connection to "
            f"<code>{html.escape(origin)}</code>. Its outbound traffic is forced "
            f"through <code>{html.escape(proxy or 'a proxy')}</code>, which "
            f"refused it — {html.escape(text)}. The site itself is most likely "
            "fine; it is this host's egress that is restricted. Shared hosts "
            "often allow only a whitelist of sites, so reaching your own servers "
            "needs unrestricted outbound access, or somewhere else to run this.",
        )
    return (
        "Upstream unreachable",
        f"Could not reach <code>{html.escape(origin)}</code> — "
        f"{html.escape(text)}. Start the service, then use Reload on this tile.",
    )


def origins_of(config: dict) -> list[str]:
    """Every upstream the proxy will serve — the allowlist.

    Must cover *all* tile types that load a URL. A type missing from here does
    not fail loudly: its pages come back as a 403 "Origin not allowed" notice.
    """
    origins = set()
    for tile in config.get("tiles", []):
        kind = tile.get("type")
        if kind in ("iframe", "carousel") and tile.get("url"):
            origins.add(origin_of(tile["url"]))
        if kind in ("rotator", "carousel"):
            for page in tile.get("pages") or []:
                # A direct page never touches the proxy, so it must not
                # widen the allowlist, and there is nothing to probe.
                if (isinstance(page, dict) and page.get("url")
                        and not page.get("direct")):
                    origins.add(origin_of(page["url"]))
    return sorted(origins)


def origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


# Headers taken from the viewer's own request and passed upstream. The proxy
# holds no credentials: you log in through the page itself, and this is what
# carries that session -- the cookie the site sets, plus whatever the framed app
# puts on its own calls (OpenObserve uses an `auth_tokens` header).
FORWARD_HEADERS = ("Cookie", "Authorization", "auth_tokens", "X-Requested-With")


def patch_script(allowed: list[str]) -> str:
    """Injected into every proxied HTML document, ahead of the app's own code.

    Rewrites fetch/XHR targets that point at an allowed upstream so they travel
    back through the proxy and pick up the auth header, instead of going direct
    and being rejected (or blocked as cross-origin).
    """
    return """
<script>
(function () {
  var ALLOWED = %(allowed)s;
  var PROXY = '/proxy/';
  // The origin this document really came from, read back out of our own path.
  var UPSTREAM = (function () {
    var m = (location.pathname || '').match(/^\\/proxy\\/(https?:\\/\\/[^\\/]+)/);
    return m ? m[1] : '';
  })();

  function proxify(url) {
    if (typeof url !== 'string' || !url) return url;
    if (url.indexOf(PROXY) === 0) return url;
    if (/^(data|blob|about|javascript|mailto|tel):/i.test(url)) return url;
    if (url.charAt(0) === '#') return url;
    var abs = url;
    if (abs.indexOf('//') === 0) abs = location.protocol + abs;
    if (/^https?:\\/\\//i.test(abs)) {
      for (var i = 0; i < ALLOWED.length; i++) {
        if (abs.indexOf(ALLOWED[i] + '/') === 0 || abs === ALLOWED[i]) return PROXY + abs;
      }
      // Same-origin means the wallboard itself, which a framed page has no
      // business calling: it is a URL the app built from location.origin, so it
      // belongs to the upstream. This is what rescues socket.io.
      if (UPSTREAM && abs.indexOf(location.origin + '/') === 0) {
        var rest = abs.slice(location.origin.length);
        if (rest.indexOf(PROXY) !== 0) return PROXY + UPSTREAM + rest;
      }
      return abs;
    }
    if (url.charAt(0) === '/' && UPSTREAM) return PROXY + UPSTREAM + url;
    return url;
  }

  // Attributes the app sets after load -- an <img src> built from an API
  // response, say -- never pass through the server's HTML rewrite.
  function fixNode(node) {
    if (!node || node.nodeType !== 1 || !node.getAttribute) return;
    ['src', 'href'].forEach(function (attr) {
      var raw = node.getAttribute(attr);
      if (!raw) return;
      var fixed = proxify(raw);
      if (fixed !== raw) node.setAttribute(attr, fixed);
    });
  }
  try {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') fixNode(r.target);
        for (var j = 0; j < (r.addedNodes || []).length; j++) {
          var n = r.addedNodes[j];
          fixNode(n);
          if (n.querySelectorAll) {
            var kids = n.querySelectorAll('[src],[href]');
            for (var k = 0; k < kids.length; k++) fixNode(kids[k]);
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'],
    });
  } catch (e) {}

  // A framed page must never register a service worker: it would be scoped to
  // the wallboard's own origin and could then intercept every request the board
  // makes, including ones to other proxied sites.
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('service workers are disabled in the wallboard proxy'));
      };
    }
  } catch (e) {}
  var _fetch = window.fetch;
  if (_fetch) window.fetch = function (input, init) {
    try {
      if (typeof input === 'string') return _fetch(proxify(input), init);
      if (input && input.url) return _fetch(new Request(proxify(input.url), input), init);
    } catch (e) {}
    return _fetch(input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = proxify(url);
    return _open.apply(this, args);
  };
})();
</script>
""" % {"allowed": json.dumps(allowed)}


class Handler(http.server.SimpleHTTPRequestHandler):
    config: dict = {}
    allowed_origins: list[str] = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    # ---- routing ----

    def do_GET(self):
        if self.path.startswith("/proxy/"):
            return self._proxy("GET")
        if self.path.startswith("/api/config"):
            return self._send_json(self._public_config())
        if self.path.startswith("/api/health"):
            return self._send_json(self._health())
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/proxy/"):
            return self._proxy("POST")
        if self.path.startswith("/api/config"):
            return self._save_config()
        return self.send_error(405)

    def _save_config(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        try:
            incoming = json.loads(self.rfile.read(length) or b"{}")
        except ValueError as exc:
            return self._send_json({"error": f"invalid JSON: {exc}"}, 400)

        try:
            merged = validate_config(incoming, type(self).config)
        except Invalid as exc:
            return self._send_json({"error": str(exc)}, 400)

        try:
            save_config(merged)
        except OSError as exc:
            return self._send_json({"error": f"could not write config: {exc}"}, 500)

        # Rebuild the proxy allowlist so a newly added panel works immediately.
        cls = type(self)
        cls.config = merged
        cls.allowed_origins = origins_of(merged)
        self._send_json({"saved": True, "config": self._public_config()})

    def do_PUT(self):
        return self._proxy("PUT") if self.path.startswith("/proxy/") else self.send_error(405)

    def do_DELETE(self):
        return self._proxy("DELETE") if self.path.startswith("/proxy/") else self.send_error(405)

    def do_OPTIONS(self):
        return self._proxy("OPTIONS") if self.path.startswith("/proxy/") else self.send_error(405)

    # ---- api ----

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_notice(self, status: int, title: str, detail: str) -> None:
        """A failing tile is shown inside an iframe, so the failure needs to be
        a presentable page rather than the stdlib's default error HTML."""
        body = f"""<!doctype html><meta charset="utf-8">
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center;
    justify-content:center; text-align:center; padding:28px;
    font:14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:#f4f5f7; color:#14161a; }}
  .t {{ font-size:15px; font-weight:650; margin-bottom:6px; }}
  .d {{ color:#5c6370; max-width:52ch; }}
  code {{ word-break:break-all; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background:#0e1014; color:#eef1f6; }} .d {{ color:#a4acbb; }}
  }}
</style>
<div><div class="t">{title}</div><div class="d">{detail}</div></div>"""
        raw = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _public_config(self) -> dict:
        """The page's view of the config. Credentials never appear here."""
        cfg = self.config
        return {
            "title": cfg.get("title", "Wallboard"),
            "timezone": cfg.get("timezone", "America/New_York"),
            "timezoneLabel": cfg.get("timezoneLabel", ""),
            "layout": cfg.get("layout", LAYOUT_VERSION),
            "types": cfg.get("types", TYPES_VERSION),
            "tiles": cfg.get("tiles", []),
        }

    def _probe(self, origin: str) -> dict:
        parts = urllib.parse.urlsplit(origin)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        up, detail = False, ""
        try:
            with socket.create_connection((parts.hostname, port), timeout=2):
                up = True
        except OSError as exc:
            detail = f"{type(exc).__name__}: {exc}"
            proxy = egress_proxy()
            if proxy:
                # The probe opens a direct socket, which a host that forces all
                # traffic through a proxy will always refuse. Say so, rather than
                # blaming the upstream.
                detail += (f" (this host sends outbound traffic through {proxy},"
                           " so a direct probe cannot succeed either way)")
        return {
            "origin": origin,
            "reachable": up,
            "detail": detail,
        }

    def _health(self) -> dict:
        """Can we actually reach each upstream? Answers the blank-tile question.

        Probed concurrently: a rotator can contribute a dozen origins, and
        serialised 2-second connect timeouts would stall every poll for half a
        minute when a few of them are down.
        """
        origins = self.allowed_origins
        if not origins:
            return {"upstreams": []}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(origins))) as pool:
            return {"upstreams": list(pool.map(self._probe, origins))}

    # ---- proxy ----

    def _target_url(self) -> str | None:
        raw = self.path[len("/proxy/"):]
        if not raw:
            return None
        # Some clients collapse the double slash in "http://".
        raw = re.sub(r"^(https?):/(?!/)", r"\1://", raw)
        return raw if re.match(r"^https?://", raw, re.I) else None

    def _proxy(self, method: str) -> None:
        target = self._target_url()
        if not target:
            return self._send_notice(
                400, "Bad proxy path",
                "The tile URL could not be parsed as an absolute http(s) URL.",
            )

        origin = origin_of(target)
        if origin not in self.allowed_origins:
            return self._send_notice(
                403, "Origin not allowed",
                f"<code>{html.escape(origin)}</code> is not one of this wallboard's "
                "configured "
                "upstreams. Add a tile pointing at it in config.json and restart.",
            )

        headers = {
            "User-Agent": self.headers.get("User-Agent", "Mozilla/5.0"),
            "Accept": self.headers.get("Accept", "*/*"),
            "Accept-Language": self.headers.get("Accept-Language", "en-US,en;q=0.9"),
            "Referer": origin + "/",
        }
        for name in FORWARD_HEADERS:
            value = self.headers.get(name)
            if value:
                headers[name] = value
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        request = urllib.request.Request(target, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data, status = response.read(), response.status
                upstream_headers = dict(response.getheaders())
        except urllib.error.HTTPError as exc:
            data = exc.read() if hasattr(exc, "read") else b""
            status = exc.code
            upstream_headers = dict(exc.headers) if exc.headers else {}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            title, detail = unreachable_notice(origin, exc)
            return self._send_notice(502, title, detail)

        if (upstream_headers.get("Content-Encoding") or "").lower() == "gzip":
            try:
                data = gzip.decompress(data)
            except OSError:
                pass

        if "text/html" in (upstream_headers.get("Content-Type") or "").lower():
            data = self._rewrite_html(data.decode("utf-8", "replace"), origin).encode("utf-8")

        self.send_response(status)
        for key, value in upstream_headers.items():
            if key.lower() in DROP_HEADERS:
                continue
            if key.lower() == "location":
                value = self._rewrite_location(value, origin)
            if key.lower() == "set-cookie":
                value = re.sub(r";\s*(Domain=[^;]*|Secure|SameSite=[^;]*)", "", value, flags=re.I)
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _rewrite_location(self, location: str, origin: str) -> str:
        if re.match(r"^https?://", location, re.I):
            return f"/proxy/{location}" if origin_of(location) in self.allowed_origins else location
        if location.startswith("/"):
            return f"/proxy/{origin}{location}"
        return location

    def _rewrite_html(self, html: str, origin: str) -> str:
        """Point the document's base at the proxied origin and install the patch.

        Both must land before any of the app's own scripts run, so they go in
        immediately after <head>.
        """
        prefix = f"/proxy/{origin}"

        def fix_base(match: re.Match) -> str:
            href = match.group(1)
            if href.startswith("/proxy/"):
                return match.group(0)
            if re.match(r"^https?://", href, re.I):
                new = "/proxy/" + href
            elif href.startswith("/"):
                new = prefix + href
            else:
                new = prefix + "/" + href.lstrip("./")
            return re.sub(r'href="[^"]*"', f'href="{new}"', match.group(0), count=1)

        had_base = re.search(r"<base\s+[^>]*href=", html, flags=re.I) is not None
        html = re.sub(r'<base\s+[^>]*href="([^"]*)"[^>]*/?>', fix_base, html, flags=re.I)

        # A <base href> only redirects PATH-relative URLs. A root-relative one
        # ("/assets/app.js") resolves against the origin and ignores the base
        # path entirely, so it escapes the proxy and 404s against the wallboard
        # itself -- which is enough to stop a single-page app booting at all.
        # Rewrite them individually.
        def fix_root_relative(match: re.Match) -> str:
            attr, quote, url = match.group(1), match.group(2), match.group(3)
            if url.startswith("//") or url.startswith("/proxy/"):
                return match.group(0)          # protocol-relative, or already ours
            return f'{attr}={quote}{prefix}{url}{quote}'

        html = re.sub(
            r'\b(src|href|action|poster|data-src)=(["\'])(/[^"\']*)\2',
            fix_root_relative, html, flags=re.I,
        )

        injection = ("" if had_base else f'<base href="{prefix}/">') + patch_script(
            self.allowed_origins
        )
        head = re.search(r"<head[^>]*>", html, flags=re.I)
        return html[:head.end()] + injection + html[head.end():] if head else injection + html


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    config = load_config()
    migrated = []
    if migrate_types(config):
        migrated.append("folded the retired widget types into the current families")
    if migrate_layout(config):
        migrated.append("converted the layout to fractional coordinates (fits any screen)")
    if migrated:
        save_config(config)
        for line in migrated:
            print(f"  {line}", flush=True)
    origins = origins_of(config)

    Handler.config, Handler.allowed_origins = config, origins

    port = int(os.environ.get("WALLBOARD_PORT") or config.get("port", 8770))
    print(f"Wallboard on http://localhost:{port}/", flush=True)
    for origin in origins:
        print(f"  upstream {origin}", flush=True)
    if not origins:
        print("  (no tiles with a url in config.json)")
    print("Ctrl+C to stop.", flush=True)

    # Bind to loopback only: this proxy deliberately strips framing protections
    # and attaches credentials, so it must not be reachable from the network.
    with ThreadedServer(("127.0.0.1", port), Handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
