// Formatting helpers shared by pages and the JSON API.

export const now = () => Math.floor(Date.now() / 1000);

/** Matches em dashes in upstream text so they can be normalized to " - ". Built from the code point to keep the source clean. */
export const EM_DASH = new RegExp(String.fromCharCode(0x2014), "g");

const T = 1e12;

/** Cycles in trillions, the unit the IC community thinks in. */
export function fmtCycles(c: number | null | undefined): string {
  if (c == null) return "unknown";
  const t = c / T;
  if (t === 0) return "0.00 T";
  if (t >= 1000) return `${fmtNum(t, 0)} T`;
  if (t >= 100) return `${t.toFixed(1)} T`;
  if (t >= 1) return `${t.toFixed(2)} T`;
  // Below a trillion, billions read better: a frozen canister holding 27.3 B is not "0.027 T".
  const b = c / 1e9;
  if (b >= 100) return `${b.toFixed(0)} B`;
  if (b >= 10) return `${b.toFixed(1)} B`;
  if (b >= 1) return `${b.toFixed(2)} B`;
  return `${(c / 1e6).toFixed(c >= 1e8 ? 0 : 1)} M`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact number: 1,241 / 812 K / 9.4 M / 6.12 B */
export function fmtCompact(n: number | null | undefined, prefix = ""): string {
  if (n == null || !isFinite(n)) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e12) return `${prefix}${(n / 1e12).toFixed(2)} T`;
  if (a >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${prefix}${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)} M`;
  if (a >= 1e4) return `${prefix}${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)} K`;
  return `${prefix}${fmtNum(n, a < 100 && a % 1 !== 0 ? 2 : 0)}`;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "n/a";
  const a = Math.abs(n);
  if (a === 0) return "$0.00";
  if (a >= 1000) return `$${fmtNum(n, a >= 100000 ? 0 : 2)}`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  if (a >= 0.01) return `$${n.toFixed(4)}`;
  // Tiny prices: keep 4 significant digits.
  const digits = Math.min(12, Math.max(4, -Math.floor(Math.log10(a)) + 3));
  return `$${n.toFixed(digits)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "n/a";
  const s = n > 0 ? "+" : "";
  return `${s}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
}

export const pctClass = (n: number | null | undefined) => (n == null || Math.abs(n) < 0.05 ? "flat" : n > 0 ? "up" : "down");

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "n/a";
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(2)} GiB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)} MiB`;
  if (n >= 2 ** 10) return `${(n / 2 ** 10).toFixed(0)} KiB`;
  return `${n} B`;
}

/** "12 s ago", "4 min ago", "2 h ago", "3 d ago" */
export function ago(ts: number | null | undefined, from = now()): string {
  if (!ts) return "never";
  const s = Math.max(0, from - ts);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Duration until a future timestamp: "8 d", "15 h", "2.4 y" */
export function until(ts: number | null | undefined, from = now()): string {
  if (!ts) return "n/a";
  return span(ts - from);
}

export function span(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 730) return `${Math.round(s / 86400)} d`;
  return `${(s / (86400 * 365)).toFixed(1)} y`;
}

export function isoDate(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toISOString();
}

export function shortDate(ts: number | null | undefined): string {
  if (!ts) return "n/a";
  return new Date(ts * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** ryjl3-tyaaa-aaaaa-aaaba-cai becomes ryjl3-tyaaa...cai */
export function shortId(id: string): string {
  const p = id.split("-");
  return p.length > 3 ? `${p[0]}-${p[1]}...${p[p.length - 1]}` : id;
}

/** Token amount from base units (as string or bigint) to a JS number. Display only. */
export function fromBase(v: string | bigint | null | undefined, decimals: number): number | null {
  if (v == null) return null;
  const b = typeof v === "bigint" ? v : BigInt(v);
  const d = 10n ** BigInt(decimals);
  return Number(b / d) + Number(b % d) / Number(d);
}

/** Deterministic color for fallback token avatars. */
export function hue(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const palette = ["#522785", "#ed1e79", "#f7931e", "#29a3e0", "#3b1fa3", "#0e8a4f", "#c2391b", "#1b6ea8", "#7a3fd1", "#d9467a"];
  return palette[h % palette.length]!;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
