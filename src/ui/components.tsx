import type { Child } from "hono/jsx";
import { ago, hue, isoDate, now } from "../lib/format";

/** Freshness + provenance line. Stale after `staleAfter` seconds, dead after 6x that. */
export function Fresh({ ts, source, staleAfter = 1800, label = "updated" }: { ts: number | null | undefined; source: string; staleAfter?: number; label?: string }) {
  const age = ts ? now() - ts : Infinity;
  const cls = age > staleAfter * 6 ? "fresh dead" : age > staleAfter ? "fresh stale" : "fresh";
  return (
    <span class={cls} data-fresh>
      <span class="dot" aria-hidden="true"></span>
      <span>
        {label}{" "}
        {ts ? <time datetime={isoDate(ts)} data-ago={ts}>{ago(ts)}</time> : "never"}
      </span>
      <span aria-hidden="true">&middot;</span>
      <span>{source}</span>
    </span>
  );
}

export type Health = "healthy" | "low" | "risk" | "frozen" | "life" | "unknown" | "gone";

const healthLabel: Record<Health, [string, string]> = {
  healthy: ["Healthy", "ok"],
  low: ["Low cycles", "low"],
  risk: ["At risk", "risk"],
  frozen: ["Frozen", "frozen"],
  life: ["Life support", "life"],
  unknown: ["Unknown", "unk"],
  gone: ["Deleted", "frozen"],
};

export function HealthPill({ health, label }: { health: string; label?: string }) {
  const [text, cls] = healthLabel[(health as Health) in healthLabel ? (health as Health) : "unknown"];
  return <span class={`pill ${cls}`}>{label ?? text}</span>;
}

/** Data-confidence indicator: measured, inferred, or unknown. Shown next to every cycle number. */
export function Conf({ confidence, source }: { confidence: string; source?: string | null }) {
  const label = confidence === "measured" ? "Measured" : confidence === "inferred" ? (source === "probe" ? "Probed" : "Inferred") : "Unknown";
  const cls = confidence === "measured" ? "measured" : confidence === "inferred" ? (source === "probe" ? "probed" : "inferred") : "unknown";
  return (
    <span class={`conf ${cls}`} title={source ? `source: ${sourceName(source)}` : undefined}>
      {label}
    </span>
  );
}

export function sourceName(s: string | null | undefined): string {
  switch (s) {
    case "sns-root": return "SNS root canister status";
    case "nns-root": return "NNS root canister status";
    case "metrics": return "canister /metrics endpoint";
    case "blackhole": return "blackhole controller status";
    case "method": return "canister cycles method";
    case "probe": return "query probe";
    default: return s ?? "none";
  }
}

export function TokenLogo({ id, symbol, logo, size }: { id: string; symbol: string; logo?: string | null; size?: "lg" | "sq" }) {
  const cls = `logo${size ? ` ${size}` : ""}`;
  if (logo) return <img class={cls} src={logo} alt="" loading="lazy" decoding="async" width={size === "lg" ? 48 : 28} height={size === "lg" ? 48 : 28} />;
  return (
    <span class={`${cls} logo-fb`} style={`background:${hue(id)}`} aria-hidden="true">
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Server-rendered sparkline. No client JS. */
export function Spark({ data, w = 120, h = 32 }: { data: number[] | null | undefined; w?: number; h?: number }) {
  if (!data || data.length < 2) return <span class="muted">n/a</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 3 - ((v - min) / range) * (h - 6)).toFixed(1)}`).join(" ");
  const up = data[data.length - 1]! >= data[0]!;
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={up ? "7 day trend up" : "7 day trend down"}>
      <polyline points={pts} fill="none" stroke={up ? "var(--up)" : "var(--down)"} stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

export function Crumbs({ items }: { items: [string, string | null][] }) {
  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      {items.map(([label, href], i) => (
        <>
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          {href ? <a href={href}>{label}</a> : <span>{label}</span>}
        </>
      ))}
    </nav>
  );
}

export function CopyId({ id }: { id: string }) {
  return (
    <button type="button" class="copy" data-copy={id} title="Copy">
      copy
    </button>
  );
}

export function Empty({ children }: { children?: Child }) {
  return <div class="empty">{children}</div>;
}
