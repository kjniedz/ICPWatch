// Chart island, loaded only on pages that have a chart. Uses TradingView's lightweight-charts (Apache 2.0).
import { AreaSeries, CandlestickSeries, ColorType, createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";

interface Point { t: number; v?: number; o?: number; h?: number; l?: number; c?: number }
interface Payload { points: Point[]; unit?: string; source?: string }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function palette() {
  return { text: css("--muted"), grid: css("--border"), line: css("--blue"), up: css("--up"), down: css("--down") };
}

function fmtValue(unit: string | undefined, v: number): string {
  if (unit === "cycles") {
    const t = v / 1e12;
    return t >= 100 ? `${t.toFixed(0)} T` : t >= 1 ? `${t.toFixed(2)} T` : `${t.toFixed(3)} T`;
  }
  if (unit === "usd") {
    const a = Math.abs(v);
    if (a >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (a >= 1) return `$${v.toFixed(2)}`;
    if (a >= 0.01) return `$${v.toFixed(4)}`;
    if (a === 0) return "$0";
    return `$${v.toFixed(Math.min(12, -Math.floor(Math.log10(a)) + 3))}`;
  }
  if (unit === "rate") return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}/s`;
  if (unit === "count") {
    const a = Math.abs(v);
    return a >= 1e9 ? `${(v / 1e9).toFixed(2)} B` : a >= 1e6 ? `${(v / 1e6).toFixed(3)} M` : a >= 1e4 ? `${(v / 1e3).toFixed(0)} K` : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return v.toLocaleString("en-US");
}

async function mount(el: HTMLElement) {
  const base = el.dataset.chart!;
  const kind = el.dataset.kind ?? "area";
  let chart: IChartApi | null = null;

  const draw = async (range: string) => {
    const res = await fetch(`${base}${base.includes("?") ? "&" : "?"}range=${range}`);
    if (!res.ok) return;
    const data = (await res.json()) as Payload;
    chart?.remove();
    el.innerHTML = "";
    if (!data.points.length) {
      el.innerHTML = `<div class="empty">No history yet. ICPWatch records its own readings, so this chart fills in from the moment a canister or token is first tracked.</div>`;
      return;
    }
    const p = palette();
    chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: p.text, fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: p.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: p.line }, vertLine: { labelBackgroundColor: p.line } },
      localization: { priceFormatter: (v: number) => fmtValue(data.unit, v) },
      handleScale: { mouseWheel: false },
    });
    if (kind === "candles" && data.points[0]?.o != null) {
      const s = chart.addSeries(CandlestickSeries, { upColor: p.up, downColor: p.down, borderVisible: false, wickUpColor: p.up, wickDownColor: p.down, priceFormat: { type: "custom", minMove: 1e-12, formatter: (v: number) => fmtValue(data.unit, v) } });
      s.setData(data.points.map((d) => ({ time: d.t as UTCTimestamp, open: d.o!, high: d.h!, low: d.l!, close: d.c! })));
    } else {
      const s = chart.addSeries(AreaSeries, { lineColor: p.line, topColor: `${p.line}55`, bottomColor: `${p.line}05`, lineWidth: 2, priceFormat: { type: "custom", minMove: 1e-12, formatter: (v: number) => fmtValue(data.unit, v) } });
      s.setData(data.points.map((d) => ({ time: d.t as UTCTimestamp, value: (d.v ?? d.c)! })));
    }
    chart.timeScale().fitContent();
  };

  // A chart listens to its own range buttons, or to a shared group selector (one control, many charts).
  const tools = document.querySelector<HTMLElement>(`[data-chart-tools="${el.id}"]`) ?? (el.dataset.group ? document.querySelector<HTMLElement>(`[data-chart-group="${el.dataset.group}"]`) : null);
  let current = el.dataset.range ?? "7d";
  tools?.querySelectorAll<HTMLButtonElement>("button[data-range]").forEach((b) => {
    b.addEventListener("click", () => {
      current = b.dataset.range!;
      tools.querySelectorAll("button[data-range]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      draw(current);
    });
  });
  document.addEventListener("themechange", () => draw(current));
  await draw(current);
}

document.querySelectorAll<HTMLElement>("[data-chart]").forEach((el) => void mount(el));
