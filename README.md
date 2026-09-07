# Wallboard

A dashboard page that embeds OpenObserve panels alongside whatever else you want
to put on it. Tiles are declared in `config.json`, so adding something later
means editing that file — not the HTML.

```sh
python3 server.py          # then open http://localhost:8770/
```

## Why there is a server at all

An OpenObserve dashboard cannot simply be dropped into an `<iframe>`. Three
things stop it, and all three are the browser doing its job:

1. OpenObserve authenticates with an `auth_tokens` header, and **browsers will
   not attach custom headers to an iframe navigation**.
2. Seeding `localStorage` in a normal tab does not carry over, because
   **third-party iframe storage is partitioned**.
3. It serves **`X-Frame-Options` / CSP `frame-ancestors`**, which forbid framing
   outright.

So `server.py` serves this page *and* reverse-proxies the upstream onto the same
origin. It attaches the credentials, drops the framing headers, rewrites the
document's `<base>`, and patches `fetch`/`XHR` inside the framed page so the
dashboard's own API calls come back through the proxy and stay authenticated.

The technique comes from `../yodeckjon/server.py`, which does the same for the
signage carousel. This version generalises it to arbitrary origins (http, and
non-default ports like `:5080`) and keeps credentials out of the source.

## Logging in

The proxy holds no credentials. If an upstream wants a login, open the page and
type it: press the **pointer** button on a Carousel to make its page
interactive, log in as you normally would, then press it again to make the tile
draggable and click-proof once more.

The session then persists because the proxy forwards the viewer's own
credentials upstream — the cookie the site set, and any header the framed app
puts on its own requests (OpenObserve uses `auth_tokens`). Nothing is stored on
disk and nothing is configured.

## Widgets

The board is a collection of widgets placed **freely**. There is no grid and no
snapping: every widget carries its own `x`, `y`, `w`, `h` in pixels and can be
put anywhere, at any size. Press **Edit layout** in the header (or open
`?edit=1`); every change is written straight back to `config.json`.

**A widget behaves as one object.** Its text is not selectable, and a widget
holding a web page keeps an invisible shield over it, so a click cannot land in
someone else's document by accident and a drag can start anywhere on the tile.
A Carousel's controls include a **pointer** button that lifts that shield when
you actually want to use the page. While a page is in use the board gets
completely out of its way: every widget's controls disappear, the board's own
corner controls disappear, and the rotation is held on that page so it cannot
advance mid-login. The tile is outlined so you can see which one is live. Leave
with **Esc**, or the single control left in the top-right corner. Entering edit
mode also ends it, so the layout is always draggable.

**Widgets carry no visible title, and no chrome at rest.** The board shows only
the content — there is no header bar at all. A widget's controls are bare icons
that fade in over its top-right corner when you hover it, and stay up while
editing. They float above the content rather than taking a strip of it, so
revealing them never resizes an iframe; and because they sit on whatever the
widget happens to be showing — often a white page — each glyph carries its own
dark outline instead of a panel behind it. There is no title to set either: since
none is drawn, there is nothing to type. One is still derived from the widget's
type when you add it, because it remains the widget's accessible name and the
wording of its remove confirmation — editing a widget leaves it untouched.

In edit mode each widget gains:

- **eight resize grips** — all four edges and all four corners. Dragging a left
  or top edge moves the widget's origin as well, so the opposite edge stays
  exactly where it was. Each axis is independent and unsnapped: any size from 3%
  of the board up to the whole of it.
- **drag from anywhere** — press and move on any part of the widget, not just
  its control bar, and drop it where you want. Widgets may overlap; whatever you
  touch last comes to the front. The edges belong to the resize grips, so a
  press there resizes instead.
- **Edit** for the widget's own settings, and **✕** to remove it. Position and
  size are not in that dialog: they come from dragging and the resize grips,
  which is the only place they are set.

The header also has **Add widget**.

**The board is always exactly one screen.** Nothing scrolls, ever. That is why
geometry is stored as a *fraction* of the canvas rather than in pixels: a widget
occupying the left third of the board occupies the left third on a laptop and on
a wall display alike. Widgets are contained to the board, so nothing can be
dragged or stretched out of sight.

### The gallery

The board's own controls — add, refresh, edit layout — live in a hot corner at
the **bottom right**: invisible until you go there, and permanently up while
editing. Each widget's own controls stay at its top right.

**Add widget** opens a picker in two steps, the way iOS does it: pick a widget
family from a grid of cards, then pick the kind you want and set its options.
Editing an existing widget goes straight to step two — a widget's family is
fixed once it exists, so there is no way back to the gallery from there.

| family | kinds | what it shows |
|---|---|---|
| **Clock** | Digital, Analog | The time in any timezone. Digital is numerals and the date; Analog is an SVG face that scales to the tile. |
| **Traffic light** | — | Whether it is safe to touch the client's live system. Just the light, no text; it stands upright or lies down to fill the tile. |
| **Note** | — | A few words pinned to the board. |
| **Calendar** | Month | This month as a grid, today marked, adjacent months dimmed. Self-contained: no data source, no network, no credentials. Weeks can start Monday or Sunday. |
| **Carousel** | — | Web pages in turn, each for its own duration — or a single page, held. |

Each family declares its own default box in `CATALOGUE` in `web/app.js`; a new
widget is auto-placed in the first free spot at that size and dragged from
there.

`iframe` and `rotator` were retired: `rotator` is now **Carousel**, and the
standalone OpenObserve panel is a Carousel holding one page, which behaves
identically. Boards are converted on first start by `migrate_types()` in
`server.py`, and a tile still carrying an old type name is folded in on the way
through `validate_config()`, so a hand-edited config cannot 400 a save.

Adding a new family means a renderer in `RENDERERS` in `web/app.js`, an entry in
`CATALOGUE` beside it, and the name in `WIDGET_KINDS` in `server.py`. The server rejects any type it does not know,
so those two lists have to agree. If the type stores fields of its own, it also
needs a branch in `validate_config()` — that function rebuilds each tile from a
fixed set of keys, so **a field with no branch is silently dropped on save**,
with a cheerful `{"saved": true}`. And if it loads URLs, it must be handled in
`origins_of()` too, or its pages come back as `403 Origin not allowed`.

### The Carousel widget

Add a **Carousel**, then list its pages in the dialog: a URL and a duration each,
in the order you want them. Drag ⠿ to reorder (or focus it and press ↑/↓), ✕ to
remove a page. Durations are 1–60 seconds and default to 10.

It keeps two stacked frames. The one on screen sits above the other, which has
already loaded the *next* page out of sight — so a change is a cross-fade
between two ready pages, not a load. The outgoing frame holds full opacity until
the incoming one has arrived and only then drops out, which avoids the dip a
plain cross-fade gives. Hovering the widget reveals **Pause**, **Next**,
**Reload** and **Open**, plus which page of how many is showing; a thin bar
along the bottom shows how much of the current page's time is left.

Behaviour worth knowing:

- **One page means no rotation at all** — no timer, and its `src` is never
  reassigned, so a live dashboard keeps its session, scroll position and
  animations indefinitely. The duration box is disabled in that case, because
  there is nothing to advance to; add a second page and it comes back. This is
  what replaced the old standalone panel, and it keeps that panel's optional
  auto-refresh.
- **Loading is never visible.** Every page loads in the covered slot, out of
  sight. If the next one is not ready when its turn comes, the widget says
  nothing and changes nothing — the page already on screen simply stays a little
  longer. There is exactly one loading indicator in the whole widget: a spinner
  on the very first paint, when the tile would otherwise be an empty box, and it
  never comes back.
- **A page that never loads is skipped**, not shown blank; the page already up
  stays up. The cost is that a slow page stretches the page before it — it waits
  up to its own duration (min 2.5s, max 8s) before giving up and skipping. If a
  whole lap loads nothing, it backs off (5s, 10s, 20s…, capped at 60s) instead of
  hammering a dead server.
- **A page the proxy refuses still gets shown**, because the proxy's own 403 /
  502 notice explains what is wrong and names the fix. That is more useful on a
  wall than a blank tile.
- **Every page is proxied**, so sites that set `X-Frame-Options` can still be
  embedded — but see Security: each page's origin joins the allowlist.

> **The `traffic-light` widget duplicates a rule.** Its cutoffs are the same
> ones as `../client-clock`, and the reasoning behind them is in that project's
> `RULES.md` — the cutoffs are the client's wall clock in US Eastern, *not*
> fixed local hours, so they follow US daylight saving on their own. The two
> copies are kept in sync by hand. If you change one, change the other.

### Editing the file directly

`config.json` is still the source of truth and can be edited by hand:

```json
{
  "id": "errors",
  "type": "iframe",
  "title": "Error rate",
  "url": "http://localhost:5080/web/short/abc123?org_identifier=default",
  "x": 0.5, "y": 0, "w": 0.5, "h": 0.6,
  "refreshMinutes": 5
}
```

Anything the page sends is validated server-side before it is written: unknown
types and non-http URLs are rejected, geometry is clamped to sane bounds, and
duplicate ids are made unique. The proxy allowlist is rebuilt on every save, so
adding a panel on a brand-new origin works without a restart.

Geometry is fractions of the board in the range 0–1, and `x + w` and `y + h` may
not exceed 1. Older layouts — the `columns` + `span`/`height` grid, and the
absolute-pixel one that briefly replaced it — are converted automatically on
first start. Pixels are scaled by the board's own extent, so the arrangement is
preserved exactly and simply resized to fill the screen.

## When a panel is blank

The header tells you which of the two it is:

- **red, “upstream unreachable”** — nothing is listening on that port. Start
  OpenObserve. The tile itself repeats the connection error.
- **amber, “up, no credentials”** — it is running but you have not given the
  server a login, so the frame will show OpenObserve's login screen.

`/api/health` returns the same information as JSON if you want to check from a
terminal.

## Security

The proxy deliberately strips framing protections, so it **binds to
`127.0.0.1` only** and refuses any origin not named by a tile in `config.json`.

**Everything is served from one origin, so cookies are shared between the pages
you proxy.** That is inherent to putting several sites behind a single host: a
cookie set while logging into one upstream is sent to every other upstream you
have listed. Combined with the fact that adding a Carousel page puts its origin
on the allowlist — and so strips that site's framing protections too — the rule
is simple: only list hosts you trust with each other. Do not expose it on a network
interface, and do not add an upstream you do not trust — you are handing it your
session.

## Putting it on the internet

`server.py` is a plain http.server app, so a WSGI host cannot import it
directly. `wsgi.py` adapts it — the same handler, driven from a WSGI request —
so there is one copy of the proxy logic, not two.

On **PythonAnywhere**, replace the contents of the web app's WSGI file
(`/var/www/<you>_pythonanywhere_com_wsgi.py`) with:

```python
import os
import sys

path = '/home/wallboard/wall-board'          # where you cloned it
if path not in sys.path:
    sys.path.insert(0, path)

# Anyone who finds the URL gets the board AND the proxy behind it. Set this.
os.environ['WALLBOARD_PASSWORD'] = 'choose-something-long'
# os.environ['WALLBOARD_USERNAME'] = 'wallboard'   # optional, this is the default

from wsgi import application               # noqa: E402,F401
```

Then hit **Reload** on the Web tab. Nothing else is needed: no virtualenv, no
requirements — it is standard library only.

Three things to know before you rely on it:

**It is public, and the proxy is the point.** On loopback that was fine. On a
public URL, anyone who reaches it can view the board, rewrite it through the
config API, and use the proxy to fetch your allowlisted origins — with the
framing protections stripped and their own cookies forwarded. Setting
`WALLBOARD_PASSWORD` puts HTTP basic auth in front of *everything*: the page,
the config API and the proxy. Leave it unset only if the host is already behind
its own access control.

**Outbound access.** The proxy has to reach your upstreams from the *host*, not
from your laptop. PythonAnywhere's free accounts can only reach a whitelist of
sites, so a private host of your own will not load; that needs a paid account.
And a tile pointing at `http://localhost:…` now means localhost *on the server*,
which is not your machine — use a publicly reachable address.

**The board is a file.** `config.json` lives in the checkout and is rewritten
whenever a widget moves. A WSGI host runs several worker processes, so each one
watches the file's timestamp and re-reads it when another worker saves — a board
edited in one process shows up in the others without a reload.

## Layout

```
config.example.json    the starter board a fresh checkout is seeded from
wsgi.py                WSGI adapter, for hosting it somewhere public
config.json            the live board — written by the page, not in git
server.py              static server + reverse proxy + config API
web/index.html         page shell and the add/edit dialog
web/app.js             widget renderers, layout editing, the gallery
web/styles.css         all styling
```

`config.json` is deliberately untracked: it is rewritten every time you move a
widget, and it names whatever hosts you point the board at. The first run copies
`config.example.json` into place.

## Running it

```sh
git clone git@github.com:bekzodbek-srp/wall-board.git
cd wall-board
python3 server.py          # then open http://localhost:8770/
```

No dependencies beyond the Python standard library.
