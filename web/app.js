"use strict";
/* Wallboard — a dashboard built from freely placed widgets.
 *
 * There is no grid. Every widget carries its own x/y/w/h in pixels and can be
 * dragged anywhere and resized to any size, on each axis independently. The
 * layout lives in config.json and is written back on every change, so the board
 * looks the same next time and for anyone else who opens it.
 */

(() => {
  if (location.protocol === "file:") {
    document.body.innerHTML =
      '<div style="padding:40px;max-width:60ch;margin:0 auto">' +
      '<h1 style="font-weight:600">Run this through the server</h1>' +
      '<p>Panels need the local proxy to authenticate and to be framable at all, ' +
      'so opening this file directly cannot work. From the project folder:</p>' +
      '<pre style="background:#1a1a1a;color:#eee;padding:12px;border-radius:8px">python3 server.py</pre>' +
      '<p>Then open <a href="http://localhost:8770/">http://localhost:8770/</a>.</p></div>';
    return;
  }

  const el = (id) => document.getElementById(id);
  const canvas = el("canvas");

  // Geometry is fractions of the canvas (0..1), not pixels, so the board fills
  // exactly one screen whatever screen that turns out to be. Minimums are given
  // in pixels and converted against the live canvas each time they are needed.
  const MIN_PX_W = 140, MIN_PX_H = 90;

  let config = { tiles: [] };
  let editing = false;
  const widgets = new Map(); // id -> { node, def, reload?, dispose? }

  const proxied = (url) => "/proxy/" + url;
  // A direct page is fetched by the browser itself, bypassing the proxy. That
  // only works for sites that allow being framed, but it also works when the
  // server has no route to them -- a host with restricted outbound traffic, say.
  const pageSrc = (page) => (page.direct ? page.url : proxied(page.url));
  const uid = (kind) => `${kind}-${Math.random().toString(36).slice(2, 8)}`;

  // Rotator page durations. Re-clamped on the client as well as the server:
  // /api/config ships tiles verbatim, config.json is hand-editable, and the
  // startup layout migration re-saves tiles without revalidating them.
  const PAGE_MIN_S = 1, PAGE_MAX_S = 60, PAGE_DEFAULT_S = 10;

  /** Wall-clock fields of an instant in a given zone. */
  function zonedParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}), hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.create(null);
    for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
    return {
      year: +p.year, month: +p.month, day: +p.day,
      hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    };
  }

  function normalisePages(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const page of raw) {
      if (!page || typeof page !== "object") continue;
      const url = String(page.url || "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      let seconds = Number(page.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) seconds = PAGE_DEFAULT_S;
      out.push({
        url,
        seconds: clamp(Math.round(seconds), PAGE_MIN_S, PAGE_MAX_S),
        direct: Boolean(page.direct),
      });
    }
    return out;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  let saveTimer = null;
  function saveSoon(delay = 400) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, delay);
  }

  /** Flush any pending save now -- a gesture has finished, or the page is going. */
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return save();
  }

  /** Take the server's canonical config without swapping the tile objects.
   *
   * Every widget closes over its own `def`. Replacing `config.tiles` wholesale
   * orphans those references: the next drag or resize mutates an object that is
   * no longer in `config`, so the screen moves and the save posts the old
   * geometry. The widget then snaps back on reload.
   */
  function adoptConfig(next) {
    const existing = new Map(config.tiles.map((tile) => [tile.id, tile]));
    config.tiles = (next.tiles || []).map((incoming) => {
      const tile = existing.get(incoming.id);
      if (!tile) return incoming;
      for (const key of Object.keys(tile)) {
        if (!(key in incoming)) delete tile[key];      // the server dropped it
      }
      return Object.assign(tile, incoming);            // same object, new values
    });
    for (const [key, value] of Object.entries(next)) {
      if (key !== "tiles") config[key] = value;
    }
  }

  async function save() {
    clearTimeout(saveTimer);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      adoptConfig(data.config);
      return true;
    } catch (err) {
      showBanner(`Could not save the layout: ${err.message}`, "bad");
      return false;
    }
  }

  // ------------------------------------------------------------------
  // The client traffic light.
  //
  // Same rule as ../client-clock (see its RULES.md): the cutoffs are the
  // client's wall clock in US Eastern, NOT fixed local hours, so they follow US
  // daylight saving on their own. Kept in sync by hand -- if you change one,
  // change the other.
  // ------------------------------------------------------------------
  const TL = {
    tz: "America/New_York",
    boundaries: [0, 5, 7],
    zones: {
      GREEN: { emoji: "\u{1F7E2}", headline: "GO",
               detail: "Safe to impersonate on live. The client is asleep." },
      YELLOW: { emoji: "\u{1F7E1}", headline: "URGENT ONLY",
                detail: "Past 5 AM for the client. Only if it is genuinely very urgent." },
      RED: { emoji: "\u{1F534}", headline: "STOP",
             detail: "Past 7 AM for the client. Do not impersonate on live." },
    },
  };

  const tlFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: TL.tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });

  function tlParts(date) {
    const p = Object.create(null);
    for (const { type, value } of tlFormat.formatToParts(date)) p[type] = value;
    return {
      year: +p.year, month: +p.month, day: +p.day,
      hour: +p.hour % 24, minute: +p.minute, second: +p.second,
      abbrev: p.timeZoneName,
    };
  }

  function tlOffset(date) {
    const p = tlParts(date);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
      - Math.floor(date.getTime() / 1000) * 1000;
  }

  // Two passes, so a guess landing on the far side of a DST switch is corrected.
  function tlInstant(year, month, day, hour) {
    const target = Date.UTC(year, month - 1, day, hour, 0, 0);
    let ts = target - tlOffset(new Date(target));
    return new Date(target - tlOffset(new Date(ts)));
  }

  const tlZone = (date) => {
    const h = tlParts(date).hour;
    return h < 5 ? "GREEN" : h < 7 ? "YELLOW" : "RED";
  };

  function tlNext(now) {
    const p = tlParts(now);
    const candidates = [];
    for (const d of [0, 1]) for (const h of TL.boundaries) {
      candidates.push(tlInstant(p.year, p.month, p.day + d, h));
    }
    candidates.sort((a, b) => a - b);
    const at = candidates.find((c) => c > now);
    return { at, key: tlZone(at) };
  }

  function humanize(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  // ------------------------------------------------------------------
  // Widget renderers. Add a key here to add a widget type; the server's
  // WIDGET_TYPES must learn about it too.
  // ------------------------------------------------------------------
  const RENDERERS = {
    iframe(def, body, head) {
      const frame = document.createElement("iframe");
      frame.setAttribute("allow", "fullscreen");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = def.title || def.id;

      const loading = document.createElement("div");
      loading.className = "state show";
      loading.innerHTML = '<div class="spinner"></div><div class="why">Loading…</div>';

      const failed = document.createElement("div");
      failed.className = "state";
      failed.innerHTML = '<div class="title">Could not load this panel</div><div class="why"></div>';

      body.append(frame, loading, failed);

      const stamp = document.createElement("span");
      stamp.className = "stamp";
      head.querySelector(".spacer").after(stamp);

      let timer = null;
      const reload = () => {
        clearTimeout(timer);
        loading.classList.add("show");
        failed.classList.remove("show");
        frame.src = proxied(def.url);
        // An iframe fires no error event for an HTTP failure, so time it out.
        timer = setTimeout(() => {
          loading.classList.remove("show");
          failed.querySelector(".why").textContent =
            "Nothing arrived within 20 seconds. If the banner above says the " +
            "upstream is unreachable, start it and press Reload.";
          failed.classList.add("show");
        }, 20000);
      };

      frame.addEventListener("load", () => {
        clearTimeout(timer);
        loading.classList.remove("show");
        failed.classList.remove("show");
        stamp.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
      });

      addHeadButton(head, "reload", "Reload this panel", reload);
      addHeadButton(head, "open", "Open in a new tab",
        () => window.open(proxied(def.url), "_blank", "noopener"));

      let auto = null;
      if (def.refreshMinutes) auto = setInterval(reload, def.refreshMinutes * 60000);
      reload();
      return { reload, dispose: () => { clearTimeout(timer); clearInterval(auto); } };
    },

    "traffic-light"(def, body) {
      // Just the light. The zone speaks for itself; anything else is noise on
      // a board you glance at.
      body.innerHTML =
        '<div class="tl">' +
          '<div class="housing">' +
            '<div class="lamp" data-zone="GREEN"></div>' +
            '<div class="lamp" data-zone="YELLOW"></div>' +
            '<div class="lamp" data-zone="RED"></div>' +
          '</div>' +
        '</div>';

      const frame = body.querySelector(".tl");
      const lamps = [...body.querySelectorAll(".lamp")];
      let last = null;

      const tick = () => {
        const key = tlZone(new Date());
        if (key === last) return;
        for (const lamp of lamps) lamp.classList.toggle("on", lamp.dataset.zone === key);
        // The only text anywhere is for screen readers.
        frame.setAttribute("role", "img");
        frame.setAttribute("aria-label", `${TL.zones[key].headline}: ${TL.zones[key].detail}`);
        last = key;
      };
      tick();
      const id = setInterval(tick, 1000);
      // Orientation (upright vs lying down) is handled by a container query in
      // the stylesheet, so there is nothing to observe here.
      return { dispose: () => clearInterval(id) };
    },

    clock(def, body) {
      const tz = safeZone(def.timezone);
      const place = def.label || (tz ? tz.split("/").pop().replace(/_/g, " ") : "");
      return def.kind === "analog"
        ? analogClock(body, tz, place)
        : digitalClock(body, tz, place);
    },

    calendar(def, body) {
      const tz = safeZone(def.timezone);
      const weekStart = def.weekStart === 0 ? 0 : 1;   // 1 = Monday
      body.innerHTML =
        '<div class="cal">' +
          '<div class="cal-month"></div>' +
          '<div class="cal-week"></div>' +
          '<div class="cal-days"></div>' +
        '</div>';
      const monthEl = body.querySelector(".cal-month");
      const weekEl = body.querySelector(".cal-week");
      const daysEl = body.querySelector(".cal-days");

      const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      weekEl.innerHTML = Array.from({ length: 7 }, (_, i) =>
        `<span>${SHORT[(i + weekStart) % 7]}</span>`).join("");

      // Calendar arithmetic only: UTC avoids any zone shifting the day number.
      const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
      const firstWeekday = (y, m) => new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 1))
        .toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });

      function draw(p) {
        monthEl.textContent = monthName(p.year, p.month);
        const lead = (firstWeekday(p.year, p.month) - weekStart + 7) % 7;
        const total = daysIn(p.year, p.month);
        const prev = daysIn(p.month === 1 ? p.year - 1 : p.year, p.month === 1 ? 12 : p.month - 1);
        const cells = [];
        for (let i = lead; i > 0; i -= 1) cells.push({ n: prev - i + 1, dim: true });
        for (let d = 1; d <= total; d += 1) cells.push({ n: d, today: d === p.day });
        while (cells.length % 7) cells.push({ n: cells.length - lead - total + 1, dim: true });
        daysEl.innerHTML = cells.map((c) =>
          `<span class="${c.today ? "today" : c.dim ? "dim" : ""}">${c.n}</span>`).join("");
      }

      let lastKey = null;
      const tick = () => {
        const p = zonedParts(new Date(), tz);
        const key = `${p.year}-${p.month}-${p.day}`;
        if (key === lastKey) return;      // redraw only when the date changes
        lastKey = key;
        draw(p);
      };
      tick();
      const id = setInterval(tick, 30000);
      return { dispose: () => clearInterval(id) };
    },

    note(def, body) {
      const div = document.createElement("div");
      div.className = "note";
      div.textContent = def.text || "";
      body.append(div);
      return {};
    },

    carousel(def, body, head) {
      const pages = normalisePages(def.pages);

      if (!pages.length) {
        body.innerHTML =
          '<div class="state show"><div class="title">No pages configured</div>' +
          '<div class="why">Use <strong>Edit</strong> on this widget to add page ' +
          'URLs and how long each should stay up.</div></div>';
        return {};
      }

      const FIRST_LOAD_MS = 20000;
      const single = pages.length === 1;

      // Two slots that swap roles. The visible one is `.on` (z-index 2); the
      // other is `.under` (z-index 1) — opaque, but wholly covered, which is
      // where the NEXT page loads unseen. A swap is two class flips: an iframe
      // is never reparented or reordered, because that reloads it.
      const slots = [0, 1].map(() => {
        const frame = document.createElement("iframe");
        frame.className = "rot-slide";
        frame.setAttribute("allow", "fullscreen");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("tabindex", "-1");
        return frame;
      });
      body.append(slots[0], slots[1]);

      // Overlay after the slides, so paint order keeps it on top. Its own
      // opacity-based class, because the shared `.state` toggles `display` and
      // so cannot cross-fade — it would produce exactly the flash we avoid.
      const overlay = document.createElement("div");
      overlay.className = "rot-overlay";
      overlay.innerHTML = '<div class="spinner"></div><div class="why"></div>';
      body.append(overlay);

      const bar = document.createElement("div");
      bar.className = "rot-progress";
      body.append(bar);

      const stamp = document.createElement("span");
      stamp.className = "stamp";
      head.querySelector(".spacer").after(stamp);

      let stopped = false;      // set before anything else in dispose()
      let gen = 0;              // invalidates async continuations
      let timer = null;         // THE rotation timer. There is only ever one.
      let paused = false;
      let index = 0;            // page on screen
      let visible = 0;          // slot showing it
      let ready = false;        // has the hidden slot finished loading?
      let waiting = false;      // dwell expired; holding for the preload
      let sawLoad = false;      // did anything load at all this lap?
      let backoff = 0;
      let refreshTimer = null;  // single-page only: the old panel's auto-refresh
      let pendingIndex = 0;     // page currently loading into the hidden slot
      let skips = 0;            // consecutive pages that never arrived
      let painted = false;      // has anything ever been shown?

      const idle = () => slots[1 - visible];
      const nextIndex = () => (index + 1) % pages.length;

      function arm(ms) {
        clearTimeout(timer);
        timer = stopped ? null : setTimeout(() => { timer = null; onTimer(); }, ms);
      }

      /** How long to hold a good page waiting for a slow next one. */
      function grace() {
        return clamp(pages[index].seconds * 1000, 2500, 8000);
      }

      function dwell() {
        const base = pages[index].seconds * 1000;
        // If a whole lap loaded nothing, stop hammering a dead server.
        return backoff
          ? Math.max(base, Math.min(60000, 5000 * 2 ** (backoff - 1)))
          : base;
      }

      const showOverlay = (text, isError) => {
        overlay.querySelector(".why").textContent = text;
        overlay.classList.toggle("error", Boolean(isError));
        overlay.classList.add("show");
      };
      const hideOverlay = () => overlay.classList.remove("show");

      function render() {
        stamp.textContent = single ? "" : `${index + 1}/${pages.length}`;
      }

      function restartBar(ms) {
        if (single) return;
        bar.style.animation = "none";
        void bar.offsetWidth;               // reflow, so the animation restarts
        bar.style.animation = `rot-progress ${ms}ms linear`;
        bar.style.animationPlayState = paused ? "paused" : "running";
      }

      /** Point the hidden slot at a page and wait for it, unseen. */
      function preload(target) {
        pendingIndex = target;
        const slot = idle();
        const mine = gen;
        ready = false;
        slot.onload = () => {
          if (stopped || mine !== gen) return;
          sawLoad = true;
          ready = true;
          if (waiting) { waiting = false; swap(); }
        };
        slot.src = pageSrc(pages[target]);
      }

      function swap() {
        if (stopped) return;
        // Something is about to be on screen, so the first-paint spinner is
        // done — even if it was page 1 that never arrived.
        painted = true;
        hideOverlay();
        // Outgoing stays opaque underneath (its idle transition delays the
        // drop to zero); incoming fades in above it. One class, two layers.
        slots[visible].classList.remove("on");
        idle().classList.add("on");
        visible = 1 - visible;
        index = pendingIndex;
        skips = 0;

        if (index === 0) {                  // a lap just completed
          backoff = sawLoad ? 0 : Math.min(backoff + 1, 4);
          sawLoad = false;
        }
        render();
        preload(nextIndex());
        const ms = dwell();
        arm(ms);
        restartBar(ms);
      }

      function onTimer() {
        if (stopped || paused) return;
        if (single) {
          // The only timer a single-page rotator ever sets: a first-load check.
          if (!painted) {
            showOverlay("This page did not load. Press Reload to try again.", true);
          }
          return;
        }
        if (waiting) {
          // The next page never arrived. Skip past it rather than promoting a
          // blank frame onto the wall, and leave the good page up.
          waiting = false;
          skips += 1;
          const ms = dwell();
          if (skips >= pages.length) {      // nothing at all is loading
            skips = 0;
            backoff = Math.min(backoff + 1, 4);
          } else {
            preload((pendingIndex + 1) % pages.length);
          }
          arm(ms);
          restartBar(ms);
          return;
        }
        if (ready) return swap();
        // Not ready. Say nothing and change nothing: the page already on screen
        // simply stays a moment longer. Loading happens entirely out of sight,
        // in the covered slot — a spinner over a page you are already watching
        // is worse than the page lingering.
        waiting = true;
        arm(grace());
      }

      function reload() {
        if (stopped) return;
        gen++;                              // drop any in-flight continuations
        const mine = gen;
        const slot = slots[visible];
        slot.onload = () => {
          if (stopped || mine !== gen) return;
          sawLoad = true;
          painted = true;
          hideOverlay();
        };
        slot.src = pageSrc(pages[index]);
        waiting = false;
        if (single) return arm(FIRST_LOAD_MS);
        preload(nextIndex());
        if (!paused) { const ms = dwell(); arm(ms); restartBar(ms); }
      }

      function setPaused(on) {
        if (on === paused) return;
        paused = on;
        setIcon(pauseBtn, paused ? "play" : "pause",
          paused ? "Resume the rotation" : "Pause the rotation");
        bar.style.animationPlayState = paused ? "paused" : "running";
        if (paused) { clearTimeout(timer); timer = null; }
        else { const ms = dwell(); arm(ms); restartBar(ms); }
      }
      const pauseBtn = addHeadButton(head, "pause", "Pause the rotation",
        () => setPaused(!paused));
      if (single) pauseBtn.hidden = true;

      const nextBtn = addHeadButton(head, "next", "Skip to the next page", () => {
        if (single || paused) return;
        clearTimeout(timer);
        timer = null;
        onTimer();
      });
      if (single) nextBtn.hidden = true;

      addHeadButton(head, "reload", "Reload the current page", reload);
      addHeadButton(head, "open", "Open the current page in a new tab", () =>
        window.open(pageSrc(pages[index]), "_blank", "noopener"));

      function dispose() {
        stopped = true;                     // first, so nothing re-arms
        gen++;                              // then invalidate continuations
        clearTimeout(timer);
        timer = null;
        clearInterval(refreshTimer);
        refreshTimer = null;
        for (const slot of slots) {
          slot.onload = null;
          // Abandoned preloads otherwise hold a proxy connection open for its
          // full 20s upstream timeout, and the browser allows only ~6 per origin.
          slot.src = "about:blank";
        }
      }

      // Start. Nothing here may throw: buildWidget has no try/catch, and a
      // throw would abort renderAll mid-loop leaving later widgets unbuilt.
      try {
        slots[0].classList.add("on");
        const mine = gen;
        slots[0].onload = () => {
          if (stopped || mine !== gen) return;
          sawLoad = true;
          painted = true;
          hideOverlay();
        };
        // The only loading state anywhere: the first paint, when the widget
        // would otherwise be an empty box. It never returns after that.
        showOverlay("");
        slots[0].src = pageSrc(pages[0]);
        render();
        if (single) {
          arm(FIRST_LOAD_MS);               // no rotation; just a load check
          // With one page there is nothing to rotate to, so the only reason to
          // touch src again is the panel's own auto-refresh, if it has one.
          if (def.refreshMinutes) {
            refreshTimer = setInterval(reload,
              clamp(def.refreshMinutes, 1, 1440) * 60000);
          }
        } else {
          preload(nextIndex());
          const ms = dwell();
          arm(ms);
          restartBar(ms);
        }
      } catch (err) {
        showOverlay(`Could not start the rotation: ${err.message}`, true);
      }

      // setPause lets the shell hold this page while someone is using it.
      return { reload, dispose, setPause: setPaused };
    },
  };

  // ---- icons -------------------------------------------------------------
  // Inline SVG on a 20x20 grid, drawn with currentColor so they inherit the
  // button's colour in both themes. Every icon button still carries a
  // title and an aria-label: the picture is the label only for sighted users.
  const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round"';

  const ICONS = {
    pause: '<path d="M6.5 4h2.6v12H6.5zM10.9 4h2.6v12h-2.6z"/>',
    play: '<path d="M7 4.3l8.6 5.7L7 15.7z"/>',
    next: '<path d="M5.5 4.3l7.2 5.7-7.2 5.7z"/><path d="M13.6 4h2v12h-2z"/>',
    reload: `<path d="M16 10a6 6 0 1 1-1.9-4.4" ${STROKE}/><path d="M16.3 3.4v3.4h-3.4" ${STROKE}/>`,
    open: `<path d="M11.5 3.5H16v4.5" ${STROKE}/><path d="M16 3.5l-6.2 6.2" ${STROKE}/>` +
          `<path d="M13.5 11.8V16H4V6.5h4.2" ${STROKE}/>`,
    edit: `<path d="M13.2 3.6l3.2 3.2L7.2 16H4v-3.2z" ${STROKE}/>`,
    remove: `<path d="M5.2 5.2l9.6 9.6M14.8 5.2l-9.6 9.6" ${STROKE}/>`,
    add: `<path d="M10 4v12M4 10h12" ${STROKE}/>`,
    done: `<path d="M4.2 10.4l3.9 3.9L15.8 5.8" ${STROKE}/>`,
    back: `<path d="M12 4.5L6.5 10l5.5 5.5" ${STROKE}/>`,
    pointer: '<path d="M5.4 3.1l9.1 5.6-3.9.9 2.1 3.9-1.7.9-2.1-3.9-2.6 2.9z"/>',
    pointerOff: '<path d="M5.4 3.1l9.1 5.6-3.9.9 2.1 3.9-1.7.9-2.1-3.9-2.6 2.9z"/>' +
      `<path d="M3.4 3.4l13.2 13.2" ${STROKE}/>`,
    famClock: `<circle cx="10" cy="10" r="6.6" ${STROKE}/><path d="M10 6.2V10l2.6 1.7" ${STROKE}/>`,
    famLight: `<rect x="6.2" y="2.6" width="7.6" height="14.8" rx="2.4" ${STROKE}/>` +
      '<circle cx="10" cy="6.2" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="13.8" r="1.5"/>',
    famNote: `<rect x="3.6" y="3.6" width="12.8" height="12.8" rx="2.4" ${STROKE}/>` +
      `<path d="M6.6 8h6.8M6.6 11h4.8" ${STROKE}/>`,
    famCalendar: `<rect x="3.2" y="4.8" width="13.6" height="11.6" rx="2.2" ${STROKE}/>` +
      `<path d="M3.2 8.6h13.6M7 3.4v2.6M13 3.4v2.6" ${STROKE}/><circle cx="10" cy="12.4" r="1.4"/>`,
    famCarousel: `<rect x="2.6" y="5" width="14.8" height="10" rx="2.2" ${STROKE}/>` +
      `<path d="M8 8.4l3 1.6-3 1.6z"/>`,
    grip: '<path d="M7 4.6a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm6 0a1.3 1.3 0 1 1 0 2.6 ' +
          '1.3 1.3 0 0 1 0-2.6zM7 8.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm6 0a1.3 1.3 0 ' +
          '1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7 12.8a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm6 0a' +
          '1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z"/>',
  };

  const icon = (name) =>
    `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">` +
    `${ICONS[name] || ""}</svg>`;

  /** Swap an icon button's glyph, e.g. pause <-> play. */
  function setIcon(button, name, label) {
    button.innerHTML = icon(name);
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function digitalClock(body, tz, place) {
    body.innerHTML =
      '<div class="bigclock"><div class="t"></div><div class="d"></div><div class="z"></div></div>';
    const t = body.querySelector(".t"), d = body.querySelector(".d"), z = body.querySelector(".z");
    z.textContent = place;
    const opts = tz ? { timeZone: tz } : {};
    const tick = () => {
      const now = new Date();
      t.textContent = now.toLocaleTimeString("en-GB", { ...opts, hour12: false });
      d.textContent = now.toLocaleDateString("en-GB",
        { ...opts, weekday: "long", day: "numeric", month: "long" });
    };
    tick();
    const id = setInterval(tick, 1000);
    return { dispose: () => clearInterval(id) };
  }

  function analogClock(body, tz, place) {
    // Inline SVG on the same 100-unit grid idiom as the button icons, so the
    // face scales to whatever box the widget is dragged to.
    const ticks = Array.from({ length: 12 }, (_, i) =>
      `<line x1="50" y1="8" x2="50" y2="${i % 3 === 0 ? 15 : 12}" ` +
      `transform="rotate(${i * 30} 50 50)" class="cl-tick${i % 3 === 0 ? " major" : ""}"/>`
    ).join("");
    body.innerHTML =
      '<div class="analog"><svg viewBox="0 0 100 100" aria-hidden="true">' +
        '<circle cx="50" cy="50" r="47" class="cl-face"/>' + ticks +
        '<line x1="50" y1="55" x2="50" y2="27" class="cl-hour"/>' +
        '<line x1="50" y1="57" x2="50" y2="16" class="cl-minute"/>' +
        '<line x1="50" y1="62" x2="50" y2="14" class="cl-second"/>' +
        '<circle cx="50" cy="50" r="2.6" class="cl-pin"/>' +
      '</svg><div class="z"></div></div>';
    const hour = body.querySelector(".cl-hour");
    const minute = body.querySelector(".cl-minute");
    const second = body.querySelector(".cl-second");
    body.querySelector(".z").textContent = place;
    const tick = () => {
      const p = zonedParts(new Date(), tz);
      const spin = (el, deg) => el.setAttribute("transform", `rotate(${deg} 50 50)`);
      spin(second, p.second * 6);
      spin(minute, p.minute * 6 + p.second * 0.1);
      spin(hour, (p.hour % 12) * 30 + p.minute * 0.5);
    };
    tick();
    const id = setInterval(tick, 1000);
    return { dispose: () => clearInterval(id) };
  }

  // A tile written before the families were folded together still renders.
  RENDERERS.rotator = RENDERERS.carousel;

  // ---- interacting with a page -------------------------------------------
  // Only one widget can be in use at a time, and while it is, every control on
  // the board gets out of its way: the page has to be usable to its edges.
  let interacting = null;

  function stopInteracting() {
    if (!interacting) return;
    const leave = interacting.leave;
    interacting = null;
    leave();
  }

  function toast(message, ms = 4000) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function addHeadButton(head, iconName, label, onClick, className = "") {
    const b = document.createElement("button");
    b.className = ("icon " + className).trim();
    setIcon(b, iconName, label);
    b.onclick = onClick;
    head.append(b);
    return b;
  }

  // ------------------------------------------------------------------
  // Geometry. Widgets are absolutely placed; nothing snaps to anything.
  // ------------------------------------------------------------------
  const box = () => ({
    w: canvas.clientWidth || 1200,
    h: canvas.clientHeight || 800,
  });
  const minW = () => Math.min(0.9, MIN_PX_W / box().w);
  const minH = () => Math.min(0.9, MIN_PX_H / box().h);

  function applyGeometry(def) {
    const w = widgets.get(def.id);
    if (!w) return;
    w.node.style.setProperty("--x", def.x);
    w.node.style.setProperty("--y", def.y);
    w.node.style.setProperty("--w", def.w);
    w.node.style.setProperty("--h", def.h);
  }

  /** Stacking order is the array order, so "bring to front" is a move to the end. */
  function applyStacking() {
    config.tiles.forEach((def, i) => {
      const w = widgets.get(def.id);
      if (w) w.node.style.zIndex = String(i + 1);
    });
  }

  function bringToFront(id) {
    const i = config.tiles.findIndex((t) => t.id === id);
    if (i < 0 || i === config.tiles.length - 1) return;
    const [tile] = config.tiles.splice(i, 1);
    config.tiles.push(tile);
    applyStacking();
  }

  /** Pull a widget back onto the board, but only if it is genuinely off it.
   *
   * This runs on every load and every window resize, so it must be a no-op for
   * a board that is already valid. It deliberately does NOT enforce the pixel
   * minimums: those belong to the drag and resize gestures. Applying them here
   * silently inflated any small widget to whatever 140x90px happened to be at
   * the current window size, and the next save of any other widget made that
   * permanent -- so a board came back moved and resized after a refresh.
   */
  function containAll() {
    let changed = false;
    for (const def of config.tiles) {
      const w = clamp(def.w, 0.01, 1);
      const h = clamp(def.h, 0.01, 1);
      const x = clamp(def.x, 0, 1 - w);
      const y = clamp(def.y, 0, 1 - h);
      if (w !== def.w || h !== def.h || x !== def.x || y !== def.y) {
        Object.assign(def, { x, y, w, h });
        changed = true;
      }
    }
    return changed;
  }

  function relayout() {
    containAll();
    for (const def of config.tiles) applyGeometry(def);
    applyStacking();
  }

  // ------------------------------------------------------------------
  // Resizing. Each grip drives one or both axes, in free pixels.
  // ------------------------------------------------------------------
  // Every edge and corner. `ew` / `ns` say which side each grip moves:
  // -1 the left/top edge (which changes x/y as well as the size), +1 the
  // right/bottom edge, 0 that axis is untouched.
  const GRIPS = [
    { cls: "n",  ew: 0,  ns: -1 }, { cls: "s",  ew: 0,  ns: 1 },
    { cls: "w",  ew: -1, ns: 0 },  { cls: "e",  ew: 1,  ns: 0 },
    { cls: "nw", ew: -1, ns: -1 }, { cls: "ne", ew: 1,  ns: -1 },
    { cls: "sw", ew: -1, ns: 1 },  { cls: "se", ew: 1,  ns: 1 },
  ];

  function wireResize(node, handle, readout, def, grip) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();                 // an edge beats a drag
      try { handle.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      node.classList.add("resizing");
      bringToFront(def.id);

      const startX = ev.clientX, startY = ev.clientY;
      const from = { x: def.x, y: def.y, w: def.w, h: def.h };
      const size = box();
      const show = () => {
        readout.textContent =
          `${Math.round(def.w * size.w)} × ${Math.round(def.h * size.h)}`;
      };
      show();

      // Pointer events arrive faster than the screen refreshes; coalescing them
      // into one write per frame stops a resize queueing up layouts.
      let latest = null;
      let frame = 0;
      const apply = () => {
        frame = 0;
        if (!latest) return;
        const dx = (latest.x - startX) / size.w;
        const dy = (latest.y - startY) / size.h;
        if (grip.ew > 0) {
          def.w = clamp(from.w + dx, minW(), 1 - from.x);
        } else if (grip.ew < 0) {
          // Dragging the left edge moves x and changes w by the same amount, so
          // the right edge stays exactly where it is.
          const right = from.x + from.w;
          def.x = clamp(from.x + dx, 0, right - minW());
          def.w = right - def.x;
        }
        if (grip.ns > 0) {
          def.h = clamp(from.h + dy, minH(), 1 - from.y);
        } else if (grip.ns < 0) {
          const bottom = from.y + from.h;
          def.y = clamp(from.y + dy, 0, bottom - minH());
          def.h = bottom - def.y;
        }
        applyGeometry(def);
        show();
      };
      const onMove = (e) => {
        latest = { x: e.clientX, y: e.clientY };
        if (!frame) frame = requestAnimationFrame(apply);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        apply();                              // land on the final position
        node.classList.remove("resizing");
        saveNow();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // ------------------------------------------------------------------
  // Dragging. Free x/y — the widget goes exactly where you drop it.
  //
  // Position is applied through CSS custom properties, never by moving the
  // element in the DOM: reparenting an iframe reloads it, which would blank
  // every panel on each nudge.
  // ------------------------------------------------------------------
  function wireDrag(node, def) {
    node.addEventListener("pointerdown", (ev) => {
      if (!editing) return;
      if (ev.target.closest("button")) return;          // let the controls work
      if (ev.target.closest(".handle")) return;         // an edge is a resize
      if (ev.pointerType === "mouse" && ev.button !== 0) return;

      ev.preventDefault();
      try { node.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      bringToFront(def.id);

      const startX = ev.clientX, startY = ev.clientY;
      const originX = def.x, originY = def.y;
      const size = box();
      let moved = false;

      // The widget is carried on a transform rather than by rewriting left/top:
      // a transform is composited, so nothing inside it re-lays out -- an iframe
      // in particular stays perfectly still. Real coordinates are committed once,
      // on release.
      let dx = 0, dy = 0, frame = 0;
      const paint = () => {
        frame = 0;
        node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      };
      const onMove = (e) => {
        const rawX = e.clientX - startX, rawY = e.clientY - startY;
        if (!moved && Math.hypot(rawX, rawY) < 4) return;   // ignore a shaky click
        if (!moved) {
          moved = true;
          node.classList.add("dragging");
          document.body.classList.add("dragging");
        }
        // Clamped in pixels, so the widget cannot be carried off the board.
        dx = clamp(rawX, -originX * size.w, (1 - def.w - originX) * size.w);
        dy = clamp(rawY, -originY * size.h, (1 - def.h - originY) * size.h);
        if (!frame) frame = requestAnimationFrame(paint);
      };
      const finish = () => {
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerup", finish);
        node.removeEventListener("pointercancel", finish);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        node.style.transform = "";
        node.classList.remove("dragging");
        document.body.classList.remove("dragging");
        if (moved) {
          def.x = clamp(originX + dx / size.w, 0, 1 - def.w);
          def.y = clamp(originY + dy / size.h, 0, 1 - def.h);
          applyGeometry(def);
          saveNow();
        }
      };
      node.addEventListener("pointermove", onMove);
      node.addEventListener("pointerup", finish);
      node.addEventListener("pointercancel", finish);
    });
  }

  // ------------------------------------------------------------------
  // Widget shell
  // ------------------------------------------------------------------
  function buildWidget(def) {
    const node = document.createElement("section");
    node.className = "widget";
    node.dataset.id = def.id;

    // The title is never drawn. It survives as the widget's accessible name and
    // as the label in the edit dialog, but the board itself stays clean.
    node.setAttribute("aria-label", def.title || def.id);

    const head = document.createElement("div");
    head.className = "head";
    const grabber = document.createElement("span");
    grabber.className = "grabber";
    grabber.innerHTML = icon("grip");
    grabber.title = def.title || def.id;
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    head.append(grabber, spacer);

    const body = document.createElement("div");
    body.className = "body";
    node.append(head, body);

    const renderer = RENDERERS[def.type];
    let handle = {};
    if (renderer) {
      // Contained deliberately: without this a throw escapes buildWidget and
      // aborts renderAll mid-loop, so every later widget is never built and the
      // board comes up mostly empty for one bad tile.
      try {
        handle = renderer(def, body, head) || {};
      } catch (err) {
        body.innerHTML =
          '<div class="state show"><div class="title">This widget failed to start</div>' +
          '<div class="why"></div></div>';
        body.querySelector(".why").textContent = String(err && err.message || err);
      }
    } else {
      body.innerHTML =
        '<div class="state show"><div class="title">Unknown widget type</div>' +
        '<div class="why">config.json asks for <code></code>.</div></div>';
      body.querySelector("code").textContent = String(def.type);
    }

    addHeadButton(head, "edit", "Edit this widget", () => openDialog(def.id), "edit-only");
    addHeadButton(head, "remove", "Remove this widget",
      () => removeWidget(def.id), "edit-only danger");

    const shield = document.createElement("div");
    shield.className = "shield";
    body.append(shield);

    const readout = document.createElement("div");
    readout.className = "size-readout";
    node.append(readout);

    for (const grip of GRIPS) {
      const knob = document.createElement("div");
      knob.className = `handle handle-${grip.cls}`;
      knob.title = "Drag to resize";
      node.append(knob);
      wireResize(node, knob, readout, def, grip);
    }
    wireDrag(node, def);

    // A widget holding a page is shielded at rest, so the tile behaves as one
    // object -- no text selection, no stray clicks into someone else's page,
    // and a drag can start anywhere on it. The toggle below lifts the shield.
    if (body.querySelector("iframe")) {
      node.classList.add("has-frame");

      const leave = () => {
        node.classList.remove("interactive");
        document.body.classList.remove("interacting");
        // Rotation was held while the page was in use; let it run again.
        if (handle.setPause) handle.setPause(false);
      };
      const enter = () => {
        stopInteracting();                   // never two at once
        node.classList.add("interactive");
        document.body.classList.add("interacting");
        // Hold this page: advancing under someone mid-login is hostile.
        if (handle.setPause) handle.setPause(true);
        interacting = { node, leave };
        toast("Using this page. Press Esc, or the corner, to stop.");
      };
      addHeadButton(head, "pointer", "Interact with this page",
        () => (node.classList.contains("interactive") ? stopInteracting() : enter()));
    }
    node.addEventListener("pointerdown", () => { if (editing) bringToFront(def.id); });

    widgets.set(def.id, { node, def, ...handle });
    applyGeometry(def);
    return node;
  }

  function removeWidget(id) {
    const w = widgets.get(id);
    if (!w) return;
    if (!confirm(`Remove “${w.def.title || id}” from the board?`)) return;
    w.dispose && w.dispose();
    w.node.remove();
    widgets.delete(id);
    config.tiles = config.tiles.filter((t) => t.id !== id);
    relayout();
    save();
  }

  function renderAll() {
    for (const w of widgets.values()) w.dispose && w.dispose();
    widgets.clear();
    canvas.textContent = "";
    for (const def of config.tiles) canvas.append(buildWidget(def));
    relayout();
  }

  // ------------------------------------------------------------------
  // Add / edit dialog. The number fields are the keyboard route to exactly
  // the same geometry the grips produce.
  // ------------------------------------------------------------------
  const dialog = el("widgetDialog");
  let dialogEditingId = null;

  function syncDialogFields() {
    for (const node of dialog.querySelectorAll("[data-for]")) {
      node.hidden = node.dataset.for !== chosenFamily;
    }
    syncCarouselRows();
  }

  /** One page means no rotation, so its duration is meaningless — disable it. */
  function syncCarouselRows() {
    if (chosenFamily !== "carousel") return;
    const rows = [...pageRowsHost().children];
    const single = rows.length <= 1;
    for (const row of rows) {
      const secs = row.querySelector(".secs");
      secs.disabled = single;
      secs.title = single ? "With one page there is nothing to rotate to" : "";
    }
    el("carouselHint").textContent = single
      ? "A single page is held on screen indefinitely — no timer, no transitions, "
        + "and it is never reloaded, so a live dashboard keeps its session. Add a "
        + "second page to start rotating."
      : "Shown in this order, each for its own duration (1–60 seconds, 10 by "
        + "default), looping forever. Drag the handle to reorder, or focus it and "
        + "press the up and down arrows.";
    el("carouselHint").textContent += " Pages marked “in browser” are loaded by "
      + "your browser; untick that for a site that refuses to be framed, and this "
      + "server will fetch it instead.";
  }

  // ---- the widget catalogue --------------------------------------------
  // One entry per family: what the gallery card shows, which kinds it comes in,
  // and the box a new one starts at. The server is still the authority on what
  // is valid (WIDGET_KINDS in server.py); this drives the picker only.
  const CATALOGUE = [
    { family: "clock", label: "Clock", icon: "famClock",
      blurb: "The time in any timezone.",
      box: { w: 0.24, h: 0.26 },
      kinds: [
        { id: "digital", label: "Digital", blurb: "Big numerals, with the date beneath." },
        { id: "analog", label: "Analog", blurb: "A traditional face and a sweeping hand." },
      ] },
    { family: "traffic-light", label: "Traffic light", icon: "famLight",
      blurb: "Whether it is safe to touch the client's live system.",
      box: { w: 0.16, h: 0.32 }, kinds: [] },
    { family: "note", label: "Note", icon: "famNote",
      blurb: "A few words pinned to the board.",
      box: { w: 0.28, h: 0.2 }, kinds: [] },
    { family: "calendar", label: "Calendar", icon: "famCalendar",
      blurb: "This month at a glance, today marked.",
      box: { w: 0.26, h: 0.42 },
      kinds: [{ id: "month", label: "Month", blurb: "A full month grid." }] },
    { family: "carousel", label: "Carousel", icon: "famCarousel",
      blurb: "Web pages in turn — or one page, held.",
      box: { w: 0.5, h: 0.55 }, kinds: [] },
  ];

  const familyOf = (name) => CATALOGUE.find((c) => c.family === name);
  let chosenFamily = null;
  let chosenKind = null;

  // ---- timezone pickers --------------------------------------------------
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let tzGroupsHtml = null;

  /** Every IANA zone the browser knows, grouped by region. Built once. */
  function timezoneGroups() {
    if (tzGroupsHtml !== null) return tzGroupsHtml;
    const zones = typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC", "America/New_York", "Europe/London", "Asia/Tashkent"];
    const now = new Date();
    const offsetOf = (zone) => {
      try {
        return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
          .formatToParts(now).find((part) => part.type === "timeZoneName").value;
      } catch { return ""; }
    };
    const groups = new Map();
    for (const zone of zones) {
      const slash = zone.indexOf("/");
      const region = slash < 0 ? "Other" : zone.slice(0, slash);
      const city = (slash < 0 ? zone : zone.slice(slash + 1)).replace(/_/g, " ");
      if (!groups.has(region)) groups.set(region, []);
      groups.get(region).push(
        `<option value="${esc(zone)}">${esc(city)} — ${esc(offsetOf(zone))}</option>`);
    }
    tzGroupsHtml = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([region, options]) => `<optgroup label="${esc(region)}">${options.join("")}</optgroup>`)
      .join("");
    return tzGroupsHtml;
  }

  function fillTimezoneSelect(select, current) {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const wanted = current || config.timezone || local || "UTC";
    // The current value goes in Suggested even if the browser has never heard
    // of it, so a hand-edited or retired zone id is never silently replaced.
    const suggested = [];
    for (const zone of [wanted, config.timezone, local]) {
      if (zone && !suggested.includes(zone)) suggested.push(zone);
    }
    select.innerHTML =
      `<optgroup label="Suggested">` +
      suggested.map((z) => `<option value="${esc(z)}">${esc(z.replace(/_/g, " "))}</option>`).join("") +
      `</optgroup>` + timezoneGroups();
    select.value = wanted;
  }

  function validTimezone(tz) {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; }
    catch { return false; }
  }

  /** A usable timezone, or undefined for the browser's own.
   *
   * config.json is hand-editable and zone ids get retired, so a widget must
   * survive being handed one Intl will not accept — passing it straight to
   * Intl throws, and a renderer that throws takes the whole board down with it.
   */
  const safeZone = (tz) => (tz && validTimezone(tz) ? tz : undefined);

  function renderGallery() {
    const box = el("gallery");
    box.innerHTML = CATALOGUE.map((c) =>
      `<button type="button" class="wcard" data-family="${c.family}">` +
        `<span class="wcard-art">${icon(c.icon)}</span>` +
        `<span class="wcard-name">${c.label}</span>` +
        `<span class="wcard-blurb">${c.blurb}</span>` +
      `</button>`).join("");
    for (const card of box.querySelectorAll(".wcard")) {
      card.onclick = () => chooseFamily(card.dataset.family);
    }
  }

  function renderKinds() {
    const cat = familyOf(chosenFamily);
    const box = el("kinds");
    // A family with a single kind has nothing to choose, so it shows no chips.
    if (!cat || cat.kinds.length < 2) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = cat.kinds.map((k) =>
      `<button type="button" class="kind${k.id === chosenKind ? " on" : ""}" ` +
        `data-kind="${k.id}" aria-pressed="${k.id === chosenKind}">` +
        `<span class="kind-name">${k.label}</span>` +
        `<span class="kind-blurb">${k.blurb}</span></button>`).join("");
    for (const chip of box.querySelectorAll(".kind")) {
      chip.onclick = () => { chosenKind = chip.dataset.kind; renderKinds(); };
    }
  }

  function showStep(step) {
    const picking = step === "pick";
    const cat = familyOf(chosenFamily);
    el("stepPick").hidden = !picking;
    el("stepConfig").hidden = picking;
    el("dialogSave").hidden = picking;
    // No way back to the gallery when editing: a widget's family is fixed.
    el("galleryBack").hidden = picking || Boolean(dialogEditingId);
    el("dialogTitle").textContent = picking
      ? "Choose a widget"
      : `${dialogEditingId ? "Edit" : "Add"} ${cat ? cat.label.toLowerCase() : "widget"}`;
  }

  function chooseFamily(family, kind = null) {
    chosenFamily = family;
    const cat = familyOf(family);
    chosenKind = kind && cat.kinds.some((k) => k.id === kind)
      ? kind
      : (cat.kinds[0] ? cat.kinds[0].id : null);
    el("dialogError").hidden = true;
    renderKinds();
    syncDialogFields();
    showStep("config");
  }

  // ---- rotator page rows -------------------------------------------------
  // The one piece of dialog state that is DOM rather than an input value, so
  // openDialog() has to clear and rebuild it explicitly; every other field is
  // assigned unconditionally and cannot go stale.
  let draggingRow = null;

  function pageRowsHost() { return el("fPages"); }

  function syncPagesEmpty() {
    el("fPagesEmpty").hidden = pageRowsHost().children.length > 0;
  }

  function movePageRow(row, delta) {
    const host = pageRowsHost();
    const rows = [...host.children];
    const to = rows.indexOf(row) + delta;
    if (to < 0 || to >= rows.length) return;
    host.insertBefore(row, delta < 0 ? rows[to] : rows[to].nextSibling);
    row.querySelector(".rot-grip").focus();
  }

  function addPageRow(url = "", seconds = PAGE_DEFAULT_S, focus = false, direct = false) {
    const row = document.createElement("div");
    row.className = "rot-row";
    row.innerHTML =
      '<button type="button" class="rot-grip" aria-label="Reorder this page" ' +
        'title="Drag to reorder, or press the up and down arrows">' + icon("grip") + '</button>' +
      '<input type="url" class="rot-url" placeholder="https://example.com" ' +
        'aria-label="Page URL">' +
      '<input type="number" class="secs" min="1" max="60" step="1" ' +
        'aria-label="Seconds to display">' +
      '<span class="unit">s</span>' +
      '<label class="rot-direct" title="Loaded by your browser, straight from the ' +
        'site. Untick to route it through this server instead, which is what lets ' +
        'a site that refuses to be framed work at all.">' +
        '<input type="checkbox" class="rot-direct-input"><span>in browser</span></label>' +
      '<button type="button" class="icon danger rot-remove" ' +
        'aria-label="Remove this page" title="Remove this page">' + icon("remove") + '</button>';

    row.querySelector(".rot-url").value = url;
    row.querySelector(".secs").value = seconds;
    row.querySelector(".rot-direct-input").checked = Boolean(direct);

    row.querySelector(".rot-remove").onclick = () => {
      row.remove();
      syncPagesEmpty();
      syncCarouselRows();
    };

    const grip = row.querySelector(".rot-grip");
    grip.addEventListener("pointerdown", () => { row.draggable = true; });
    grip.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      ev.preventDefault();
      movePageRow(row, ev.key === "ArrowUp" ? -1 : 1);
    });

    row.addEventListener("dragstart", (ev) => {
      draggingRow = row;
      row.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", "");   // Firefox needs some payload
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      row.draggable = false;
      draggingRow = null;
      for (const other of pageRowsHost().children) other.classList.remove("drop-target");
    });
    row.addEventListener("dragover", (ev) => {
      if (!draggingRow || draggingRow === row) return;
      ev.preventDefault();
      const box = row.getBoundingClientRect();
      const below = ev.clientY > box.top + box.height / 2;
      row.parentNode.insertBefore(draggingRow, below ? row.nextSibling : row);
    });

    pageRowsHost().append(row);
    syncPagesEmpty();
    syncCarouselRows();
    if (focus) row.querySelector(".rot-url").focus();
    return row;
  }

  function setPageRows(pages) {
    pageRowsHost().textContent = "";
    for (const page of pages) addPageRow(page.url, page.seconds, false, page.direct);
    syncPagesEmpty();
  }

  /** Rows with a URL in them, in the order they appear. Blank rows are ignored. */
  function readPageRows() {
    return [...pageRowsHost().children].reduce((out, row) => {
      const url = row.querySelector(".rot-url").value.trim();
      if (!url) return out;
      const raw = Number(row.querySelector(".secs").value);
      const seconds = Number.isFinite(raw) && raw > 0
        ? clamp(Math.round(raw), PAGE_MIN_S, PAGE_MAX_S)
        : PAGE_DEFAULT_S;
      out.push({ url, seconds, direct: row.querySelector(".rot-direct-input").checked });
      return out;
    }, []);
  }

  function openDialog(id = null) {
    dialogEditingId = id;
    const def = id ? config.tiles.find((t) => t.id === id) : null;
    el("dialogError").hidden = true;

    // Every field is reset on every open. Only fields belonging to the widget
    // being edited take its values; the rest go back to their defaults, or a
    // half-filled pane from the last widget bleeds into this one.
    const own = (family) => (def && def.type === family ? def : null);
    const clock = own("clock"), cal = own("calendar"), note = own("note");
    fillTimezoneSelect(el("fTimezone"), clock ? clock.timezone : null);
    el("fLabel").value = clock ? clock.label || "" : "";
    fillTimezoneSelect(el("fCalTimezone"), cal ? cal.timezone : null);
    el("fWeekStart").value = cal && cal.weekStart === 0 ? "0" : "1";
    el("fText").value = note ? note.text || "" : "";
    setPageRows(own("carousel") ? normalisePages(def.pages) : []);

    if (def) {
      chooseFamily(def.type, def.kind || null);       // straight to its options
    } else {
      chosenFamily = null;
      chosenKind = null;
      renderGallery();
      showStep("pick");
    }
    dialog.showModal();
  }

  /** First spot, top-to-bottom, where a w x h box would not cover a widget.
   *
   * This is now the only thing that positions a new widget -- position and size
   * are otherwise set by dragging -- so it is worth landing somewhere usable
   * rather than always on top of whatever is already at the origin.
   */
  function findFreeSpot(w, h) {
    const steps = 20;                       // a 5% grid over the board
    const fits = (x, y) => !config.tiles.some((t) =>
      x < t.x + t.w && x + w > t.x && y < t.y + t.h && y + h > t.y);
    for (let row = 0; row / steps + h <= 1.001; row += 1) {
      for (let col = 0; col / steps + w <= 1.001; col += 1) {
        const x = col / steps, y = row / steps;
        if (fits(x, y)) return { x, y };
      }
    }
    return { x: 0, y: 0 };                  // board is full; drop it on top
  }

  async function commitDialog() {
    const family = chosenFamily;
    const cat = familyOf(family);
    if (!cat) return showDialogError("Choose a widget first.");

    const draft = { id: dialogEditingId || uid(family), type: family };
    if (cat.kinds.length) draft.kind = chosenKind || cat.kinds[0].id;

    if (family === "carousel") {
      const pages = readPageRows();
      if (!pages.length) {
        return showDialogError("Add at least one page URL.");
      }
      const bad = pages.find((page) => !/^https?:\/\//i.test(page.url));
      if (bad) {
        return showDialogError(`“${bad.url}” needs to start with http:// or https://.`);
      }
      draft.pages = pages;
    } else if (family === "clock") {
      draft.timezone = el("fTimezone").value.trim() || "America/New_York";
      draft.label = el("fLabel").value.trim();
      if (!validTimezone(draft.timezone)) {
        return showDialogError(`“${draft.timezone}” is not a timezone this browser knows.`);
      }
    } else if (family === "calendar") {
      draft.timezone = el("fCalTimezone").value.trim() || "America/New_York";
      if (!validTimezone(draft.timezone)) {
        return showDialogError(`“${draft.timezone}” is not a timezone this browser knows.`);
      }
      draft.weekStart = el("fWeekStart").value === "0" ? 0 : 1;
    } else if (family === "note") {
      draft.text = el("fText").value;
    }

    // Neither the title nor the geometry is typed any more: nothing draws a
    // title, and position and size come from dragging the widget on the board.
    // Both are set only when the widget is first created — for an existing one
    // they are absent from `draft`, and the merge below leaves them alone.
    if (!dialogEditingId) {
      draft.title = cat.label;
      const { w, h } = cat.box;
      Object.assign(draft, { w, h, ...findFreeSpot(w, h) });
    }

    const before = JSON.parse(JSON.stringify(config.tiles));
    if (dialogEditingId) {
      const i = config.tiles.findIndex((t) => t.id === dialogEditingId);
      config.tiles[i] = { ...config.tiles[i], ...draft };
    } else {
      config.tiles.push(draft);
    }

    if (await save()) {
      dialog.close();
      renderAll();
    } else {
      config.tiles = before;   // server rejected it; do not keep a bad layout
    }
  }

  function showDialogError(message) {
    const box = el("dialogError");
    box.textContent = message;
    box.hidden = false;
  }

  // ------------------------------------------------------------------
  // Header
  // ------------------------------------------------------------------
  function setEditing(on) {
    if (on) stopInteracting();
    editing = on;
    document.body.classList.toggle("editing", on);
    setIcon(el("editToggle"), on ? "done" : "edit",
      on ? "Finish editing the layout" : "Edit the layout");
    el("editToggle").classList.toggle("primary", on);
  }

  function showBanner(html, kind) {
    const banner = el("banner");
    banner.className = "banner" + (kind === "warn" ? " warn" : "");
    banner.innerHTML = html;
    banner.hidden = false;
  }

  // With no header there is no status pill; an upstream problem announces
  // itself with the banner and is otherwise silent.
  async function pollHealth() {
    try {
      const { upstreams } = await (await fetch("/api/health", { cache: "no-store" })).json();
      const down = upstreams.filter((u) => !u.reachable);
      if (down.length) {
        showBanner("<strong>Cannot reach " +
          down.map((u) => `<code>${u.origin}</code>`).join(", ") +
          ".</strong> Those panels will stay empty until the service is running.", "bad");
      } else {
        el("banner").hidden = true;
      }
    } catch {
      showBanner("<strong>The wallboard server is not responding.</strong> " +
        "The board keeps showing whatever it last loaded.", "bad");
    }
  }

  async function boot() {
    config = await (await fetch("/api/config", { cache: "no-store" })).json();
    document.title = config.title || "Wallboard";
    renderAll();

    for (const node of document.querySelectorAll("[data-icon]")) {
      node.innerHTML = icon(node.dataset.icon);
    }
    el("editToggle").onclick = () => setEditing(!editing);
    el("addWidget").onclick = () => openDialog(null);
    el("refreshAll").onclick = () => widgets.forEach((w) => w.reload && w.reload());
    el("galleryBack").onclick = () => showStep("pick");
    // New pages default to loading in the browser. The proxy is the fallback
    // for sites that refuse to be framed, not the normal route.
    el("fAddPage").onclick = () => addPageRow("", PAGE_DEFAULT_S, true, true);
    el("dialogCancel").onclick = () => dialog.close();
    el("dialogSave").onclick = commitDialog;

    el("stopInteract").onclick = stopInteracting;
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && interacting) { ev.preventDefault(); stopInteracting(); }
    });

    if (new URLSearchParams(location.search).has("edit")) setEditing(true);

    // Fractions survive a resize on their own; this only re-applies the pixel
    // minimums, which do change with the window.
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayout, 150);
    });

    pollHealth();
    setInterval(pollHealth, 15000);
  }

  boot().catch((err) => showBanner(`Could not start: ${err.message}`, "bad"));
})();
