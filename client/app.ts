// ICPWatch client islands. Pages are fully server rendered; this file only adds behavior.
// Keep it small: no framework, no dependencies.

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

// Theme ----------------------------------------------------------------------
function initTheme() {
  const apply = (t: string) => {
    document.documentElement.dataset.theme = t;
    $$("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === t)));
    document.dispatchEvent(new CustomEvent("themechange", { detail: t }));
  };
  apply(document.documentElement.dataset.theme || "dark");
  $$("[data-theme-set]").forEach((b) =>
    b.addEventListener("click", () => {
      const t = b.dataset.themeSet!;
      try {
        localStorage.setItem("theme", t);
      } catch {
        /* ignore */
      }
      apply(t);
    }),
  );
}

// Relative times -------------------------------------------------------------
function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function tickTimes() {
  $$("[data-ago]").forEach((el) => {
    el.textContent = ago(Number(el.dataset.ago));
  });
}

// Sortable, filterable tables -------------------------------------------------
// th[data-sort="key"] sorts rows by td[data-v] in the same column index.
// [data-filter-for="tableId"] inputs filter by row text; [data-fkey][data-fval] pills filter by row data attributes.
function initTables(root: ParentNode = document) {
  $$<HTMLTableElement>("table[data-sortable]", root).forEach((table) => {
    if (table.dataset.ready) return;
    table.dataset.ready = "1";
    const tbody = table.tBodies[0];
    if (!tbody) return;
    $$<HTMLTableCellElement>("th[data-sort]", table).forEach((th) => {
      th.tabIndex = 0;
      const run = () => {
        const idx = th.cellIndex;
        const dir = th.getAttribute("aria-sort") === "descending" ? "ascending" : "descending";
        $$("th[aria-sort]", table).forEach((o) => o.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", dir);
        const sign = dir === "ascending" ? 1 : -1;
        const rows = Array.from(tbody.rows);
        const val = (r: HTMLTableRowElement) => r.cells[idx]?.dataset.v ?? r.cells[idx]?.textContent ?? "";
        rows.sort((a, b) => {
          const av = val(a);
          const bv = val(b);
          const an = Number(av);
          const bn = Number(bv);
          const aMissing = av === "" || (th.dataset.sort === "num" && isNaN(an));
          const bMissing = bv === "" || (th.dataset.sort === "num" && isNaN(bn));
          if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1; // unknowns always last
          if (th.dataset.sort === "num") return (an - bn) * sign;
          return av.localeCompare(bv) * sign;
        });
        rows.forEach((r) => tbody.appendChild(r));
        if (table.id) store.set(`sort:${table.id}`, { i: idx, dir });
      };
      th.addEventListener("click", run);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          run();
        }
      });
    });
  });
}

const filterState = new Map<string, { text: string; pills: Record<string, string> }>();

function applyFilter(tableId: string) {
  const table = document.getElementById(tableId) as HTMLTableElement | null;
  if (!table?.tBodies[0]) return;
  const st = filterState.get(tableId) ?? { text: "", pills: {} };
  const q = st.text.trim().toLowerCase();
  let shown = 0;
  for (const row of Array.from(table.tBodies[0].rows)) {
    let ok = !q || (row.dataset.search ?? row.textContent ?? "").toLowerCase().includes(q);
    for (const [k, v] of Object.entries(st.pills)) {
      if (!ok || !v || v === "all") continue;
      if (k === "watch") ok = watchlist().includes(row.dataset.id ?? "");
      else ok = (row.dataset[k] ?? "").split(" ").includes(v);
    }
    row.hidden = !ok;
    if (ok) shown++;
  }
  const empty = $(`[data-empty-for="${tableId}"]`);
  if (empty) empty.hidden = shown > 0;
  const count = $(`[data-count-for="${tableId}"]`);
  if (count) count.textContent = String(shown);
}

// Delegated so filters keep working after a live refresh swaps the markup.
function initFilters() {
  document.addEventListener("input", (e) => {
    const input = (e.target as Element).closest<HTMLInputElement>("input[data-filter-for]");
    if (!input) return;
    const id = input.dataset.filterFor!;
    const st = filterState.get(id) ?? { text: "", pills: {} };
    st.text = input.value;
    filterState.set(id, st);
    applyFilter(id);
  });
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-fkey]");
    if (!btn) return;
    const id = btn.dataset.for!;
    const key = btn.dataset.fkey!;
    const st = filterState.get(id) ?? { text: "", pills: {} };
    st.pills[key] = btn.dataset.fval!;
    filterState.set(id, st);
    paintFilters(id);
    applyFilter(id);
  });
}

/** Re-sync filter controls with stored state (after a live swap re-renders them). */
function paintFilters(id: string) {
  const st = filterState.get(id);
  if (!st) return;
  const input = $<HTMLInputElement>(`input[data-filter-for="${id}"]`);
  if (input && input.value !== st.text && document.activeElement !== input) input.value = st.text;
  for (const [key, val] of Object.entries(st.pills)) {
    $$(`button[data-fkey="${key}"][data-for="${id}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fval === val)));
  }
}

// Watchlist (local, no account needed) ---------------------------------------
const watchlist = () => store.get<string[]>("watchlist", []);
function initWatchlist(root: ParentNode = document) {
  const list = new Set(watchlist());
  $$<HTMLButtonElement>("button[data-star]", root).forEach((b) => {
    const id = b.dataset.star!;
    const paint = () => {
      b.setAttribute("aria-pressed", String(list.has(id)));
      b.textContent = list.has(id) ? "★" : "☆";
    };
    paint();
    if (b.dataset.ready) return;
    b.dataset.ready = "1";
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (list.has(id)) list.delete(id);
      else list.add(id);
      store.set("watchlist", [...list]);
      paint();
    });
  });
}

// Copy buttons ----------------------------------------------------------------
function toast(msg: string) {
  $(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
function initCopy() {
  document.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-copy]");
    if (!b) return;
    navigator.clipboard?.writeText(b.dataset.copy!).then(() => toast("Copied"));
  });
}

// Live refresh ------------------------------------------------------------------
// <div data-live="/lifeline?fragment=table" data-every="30"> is re-fetched and swapped in place.
// Filters and sort are re-applied after each swap, and nothing is fetched while the tab is hidden.
function initLive() {
  $$("[data-live]").forEach((box) => {
    const url = box.dataset.live!;
    const every = Math.max(10, Number(box.dataset.every ?? 30)) * 1000;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const v = box.dataset.version ?? "";
        const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`, { headers: { accept: "text/html" } });
        // 204 means nothing changed since our version: keep the DOM as is.
        if (res.status === 200) {
          box.dataset.version = res.headers.get("x-version") ?? v;
          const html = await res.text();
          const sorts = $$<HTMLTableElement>("table[data-sortable]", box).map((t) => ({ id: t.id, th: $("th[aria-sort]", t) as HTMLTableCellElement | null }));
          const state = sorts.map((s) => ({ id: s.id, i: s.th?.cellIndex, dir: s.th?.getAttribute("aria-sort") }));
          // Swap only the [data-part] regions so inputs outside them keep focus and state.
          const tpl = document.createElement("template");
          tpl.innerHTML = html;
          const parts = $$("[data-part]", tpl.content);
          if (parts.length) {
            for (const np of parts) box.querySelector(`[data-part="${np.dataset.part}"]`)?.replaceWith(np);
          } else {
            box.innerHTML = html;
          }
          initTables(box);
          initWatchlist(box);
          for (const s of state) {
            if (s.i == null || !s.id) continue;
            const th = (document.getElementById(s.id) as HTMLTableElement | null)?.tHead?.rows[0]?.cells[s.i];
            if (!th) continue;
            // Clicking toggles direction, so prime the opposite one first.
            th.setAttribute("aria-sort", s.dir === "descending" ? "ascending" : "descending");
            th.click();
          }
          for (const id of filterState.keys()) {
            paintFilters(id);
            applyFilter(id);
          }
          tickTimes();
        }
      } catch {
        /* network blip: keep the old data, the freshness dot will show it aging */
      } finally {
        busy = false;
      }
    };
    setInterval(refresh, every);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
  });
}

// Global search with suggestions -------------------------------------------------
function initSearch() {
  $$<HTMLFormElement>("form[data-search]").forEach((form) => {
    const input = $<HTMLInputElement>("input", form)!;
    let box: HTMLElement | null = null;
    let timer = 0;
    let seq = 0;
    let active = -1;
    const close = () => {
      box?.remove();
      box = null;
      active = -1;
    };
    const render = (items: { type: string; title: string; sub?: string; href: string }[]) => {
      close();
      if (!items.length) return;
      box = document.createElement("div");
      box.className = "suggest card";
      box.setAttribute("role", "listbox");
      for (const it of items) {
        const a = document.createElement("a");
        a.href = it.href;
        a.setAttribute("role", "option");
        const ty = document.createElement("span");
        ty.className = "ty";
        ty.textContent = it.type;
        const tt = document.createElement("span");
        tt.className = "tt";
        tt.textContent = it.title;
        a.append(ty, tt);
        if (it.sub) {
          const ss = document.createElement("span");
          ss.className = "ss";
          ss.textContent = it.sub;
          a.append(ss);
        }
        box.append(a);
      }
      form.append(box);
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return close();
      timer = window.setTimeout(async () => {
        const mine = ++seq;
        try {
          const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}`);
          if (!res.ok || mine !== seq) return;
          render(((await res.json()) as { results: { type: string; title: string; sub?: string; href: string }[] }).results);
        } catch {
          /* ignore */
        }
      }, 120);
    });
    input.addEventListener("keydown", (e) => {
      if (!box) return;
      const links = $$<HTMLAnchorElement>("a", box);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
        links.forEach((l, i) => l.classList.toggle("on", i === active));
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        location.href = links[active]!.href;
      } else if (e.key === "Escape") close();
    });
    document.addEventListener("click", (e) => {
      if (!form.contains(e.target as Node)) close();
    });
  });
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key !== "/" || e.metaKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const input = $<HTMLInputElement>(".bigsearch input") ?? $<HTMLInputElement>(".hdr-search input");
    if (input && input.offsetParent !== null) {
      e.preventDefault();
      input.focus();
    }
  });
}

// Watchlist and portfolio pages render from local state ----------------------------
function initLocalPages() {
  const wl = $("[data-watchlist-page]");
  if (wl) {
    const ids = watchlist();
    const st = { text: "", pills: { watch: "on" } };
    filterState.set("tokens", st);
    applyFilter("tokens");
    const none = $("[data-watchlist-empty]");
    if (none) none.hidden = ids.length > 0;
  }
  // Saved screener filters
  const saved = $("[data-saved-filters]");
  if (saved) {
    const paint = () => {
      const items = store.get<{ name: string; qs: string }[]>("screens", []);
      saved.innerHTML = "";
      for (const it of items) {
        const a = document.createElement("a");
        a.className = "fpill";
        a.href = `/markets/screener?${it.qs}`;
        a.textContent = it.name;
        saved.append(a);
      }
      if (!items.length) saved.textContent = "No saved filters yet.";
    };
    paint();
    $("[data-save-filter]")?.addEventListener("click", () => {
      const name = ($<HTMLInputElement>("[data-save-name]")?.value || "").trim() || `Filter ${new Date().toLocaleDateString()}`;
      const items = store.get<{ name: string; qs: string }[]>("screens", []);
      items.unshift({ name, qs: location.search.slice(1) });
      store.set("screens", items.slice(0, 20));
      paint();
      toast("Filter saved on this device");
    });
  }
}

initTheme();
initTables();
initFilters();
initWatchlist();
initCopy();
initLive();
initSearch();
initLocalPages();
tickTimes();
setInterval(tickTimes, 1000);
