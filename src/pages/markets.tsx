import type { Kv, PoolRow, TokenMarketRow } from "../db/queries";
import { fmtCompact, fmtNum, fmtPct, fmtUsd, pctClass } from "../lib/format";
import { Empty, Fresh, HealthPill, Spark, TokenLogo } from "../ui/components";

export interface MarketTotals { tvl_usd: number; vol_24h_usd: number; pools: number; tokens: number; priced: number; dexes: string[] }

const parse = <T,>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** "Archive at risk", "Ledger low", "Index frozen": the Lifeline signal no other markets site shows. */
export function tokenHealthLabel(t: { worst_health: string | null; health_note: string | null; canister_count: number }): { health: string; label: string } {
  if (!t.canister_count || !t.worst_health) return { health: "unknown", label: "Not watched" };
  const role = t.health_note === "archive" ? "Archive" : t.health_note === "index" ? "Index" : "Ledger";
  switch (t.worst_health) {
    case "healthy": return { health: "healthy", label: "Healthy" };
    case "low": return { health: "low", label: `${role} low` };
    case "risk": return { health: "risk", label: `${role} at risk` };
    case "frozen": return { health: "frozen", label: `${role} frozen` };
    case "gone": return { health: "gone", label: `${role} uninstalled` };
    case "life": return { health: "life", label: "Life support" };
    default: return { health: "unknown", label: "Balance unknown" };
  }
}

const kindChip = (k: string) => (k === "sns" ? <span class="chip">SNS</span> : k === "ck" ? <span class="chip">ck</span> : null);

function Pct({ v }: { v: number | null | undefined }) {
  return <span class={`num ${pctClass(v)}`}>{fmtPct(v)}</span>;
}

function topLiq(t: TokenMarketRow) {
  const liq = parse<{ dex: string; tvl_usd: number; share: number }[]>(t.liquidity, []);
  return liq.length ? liq[0]! : null;
}

export function TokenTable({ rows, id = "tokens" }: { rows: TokenMarketRow[]; id?: string }) {
  return (
    <div class="card tbl-wrap">
      <table class="tbl" id={id} data-sortable>
        <thead>
          <tr>
            <th style="width:34px"><span class="sr">Watch</span></th>
            <th class="hide-m" style="width:36px">#</th>
            <th data-sort="text">Name</th>
            <th class="r" data-sort="num">Price</th>
            <th class="r" data-sort="num">24h %</th>
            <th class="r" data-sort="num">7d %</th>
            <th class="r hide-m" data-sort="num">30d %</th>
            <th class="r" data-sort="num">24h volume</th>
            <th class="r" data-sort="num" aria-sort="descending">Market cap</th>
            <th data-sort="num">Liquidity sits on</th>
            <th class="hide-m">Last 7 days</th>
            <th data-sort="text">Health</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const liq = topLiq(t);
            const h = tokenHealthLabel(t);
            return (
              <tr data-id={t.id} data-kind={t.kind} data-hstate={h.health === "healthy" ? "healthy" : h.health === "unknown" ? "unknown" : "risk"} data-search={`${t.symbol} ${t.name} ${t.id}`}>
                <td><button class="star" data-star={t.id} aria-label={`Watch ${t.symbol}`} aria-pressed="false">&#9734;</button></td>
                <td class="muted hide-m">{i + 1}</td>
                <td data-v={t.name.toLowerCase()}>
                  <a class="name" href={`/token/${t.id}`}>
                    <TokenLogo id={t.id} symbol={t.symbol} logo={t.logo} />
                    <span>
                      <span class="t">{t.name}</span>
                      <span class="sub">{t.symbol} {kindChip(t.kind)}</span>
                    </span>
                  </a>
                </td>
                <td class="r num strong" data-v={t.price_usd ?? ""}>{fmtUsd(t.price_usd)}</td>
                <td class="r" data-v={t.chg_24h ?? ""}><Pct v={t.chg_24h} /></td>
                <td class="r" data-v={t.chg_7d ?? ""}><Pct v={t.chg_7d} /></td>
                <td class="r hide-m" data-v={t.chg_30d ?? ""}><Pct v={t.chg_30d} /></td>
                <td class="r num" data-v={t.vol_24h_usd ?? ""}>{fmtCompact(t.vol_24h_usd, "$")}</td>
                <td class="r num" data-v={t.mcap_usd ?? ""}>{fmtCompact(t.mcap_usd, "$")}</td>
                <td data-v={t.tvl_usd ?? ""}>
                  {liq ? (
                    <span class="liq" title={`${fmtUsd(t.tvl_usd)} total liquidity`}>
                      <i><b style={`width:${Math.round(liq.share * 100)}%`}></b></i>
                      {liq.dex} {Math.round(liq.share * 100)}%
                    </span>
                  ) : <span class="muted">no pools</span>}
                </td>
                <td class="hide-m"><Spark data={parse<number[] | null>(t.spark_7d, null)} /></td>
                <td data-v={h.health}><a href={`/token/${t.id}#health`}><HealthPill health={h.health} label={h.label} /></a></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div data-empty-for={id} hidden={rows.length > 0}>
        <Empty>{rows.length ? "No tokens match." : "Token registry is still being built by the first discovery run."}</Empty>
      </div>
    </div>
  );
}

function Mini({ title, color, note, children }: { title: string; color: string; note: string; children?: unknown }) {
  return (
    <div class="card mini">
      <h3><span><span class="bar-l" style={`background:${color}`}></span>{title}</span><small>{note}</small></h3>
      <ol>{children}</ol>
    </div>
  );
}

function Movers({ rows }: { rows: TokenMarketRow[] }) {
  if (!rows.length) return <li class="muted" style="font-size:12px">Waiting for price history.</li>;
  return (
    <>
      {rows.map((t, i) => (
        <li>
          <span class="i">{i + 1}</span>
          <TokenLogo id={t.id} symbol={t.symbol} logo={t.logo} size="sq" />
          <a class="n" href={`/token/${t.id}`}><b>{t.name}</b><small>{t.symbol}</small></a>
          <span class="p"><b>{fmtUsd(t.price_usd)}</b><small class={pctClass(t.chg_24h)}>{fmtPct(t.chg_24h)}</small></span>
        </li>
      ))}
    </>
  );
}

export function MarketsPage({ rows, pools, totals }: { rows: TokenMarketRow[]; pools: PoolRow[]; totals: Kv<MarketTotals> | null }) {
  // Movers need real liquidity behind them, otherwise dust pools dominate the list.
  const movable = rows.filter((t) => t.chg_24h != null && (t.tvl_usd ?? 0) >= 5000);
  const gainers = [...movable].sort((a, b) => b.chg_24h! - a.chg_24h!).filter((t) => t.chg_24h! > 0).slice(0, 5);
  const losers = [...movable].sort((a, b) => a.chg_24h! - b.chg_24h!).filter((t) => t.chg_24h! < 0).slice(0, 5);
  const tv = totals?.value;
  return (
    <div class="wrap page" style="max-width:1340px">
      <div class="card statbar">
        <div><div class="v c-green">{fmtCompact(tv?.tvl_usd, "$")}</div><div class="k">TVL across DEXs</div></div>
        <div><div class="v">{fmtCompact(tv?.vol_24h_usd, "$")}</div><div class="k">24h volume</div></div>
        <div><div class="v">{fmtNum(tv?.pools)}</div><div class="k">Pools</div></div>
        <div><div class="v">{fmtNum(rows.length)}</div><div class="k">Tokens tracked</div></div>
        <div><div class="v">{fmtNum(tv?.priced)}</div><div class="k">With live price</div></div>
        <div class="meta">
          <Fresh ts={totals?.fetched_at} source={tv?.dexes?.join(" · ") || "DEX canisters"} staleAfter={900} label="aggregated" />
        </div>
      </div>

      <div class="grid-3" style="margin-top:16px">
        <Mini title="Top Gainers (24h)" color="var(--up)" note="all DEXs"><Movers rows={gainers} /></Mini>
        <Mini title="Top Losers (24h)" color="var(--down)" note="all DEXs"><Movers rows={losers} /></Mini>
        <Mini title="Hot Pools (24h volume)" color="var(--orange)" note="">
          {pools.length ? pools.slice(0, 5).map((p, i) => (
            <li>
              <span class="i">{i + 1}</span>
              <a class="n" href={`/token/${p.token0}`}><b>{p.symbol0} / {p.symbol1}</b><small>{p.dex}</small></a>
              <span class="p"><b>{fmtCompact(p.vol_24h_usd, "$")}</b><small class="muted">TVL {fmtCompact(p.tvl_usd, "$")}</small></span>
            </li>
          )) : <li class="muted" style="font-size:12px">Waiting for the first market run.</li>}
        </Mini>
      </div>

      <div class="sec-head">
        <h2>All tokens <span class="muted" style="font-weight:500;font-size:12px">&nbsp;<span data-count-for="tokens">{rows.length}</span> shown</span></h2>
        <div class="filters">
          <input class="input" type="search" placeholder="Filter tokens" data-filter-for="tokens" aria-label="Filter tokens" />
          <button class="fpill" data-for="tokens" data-fkey="kind" data-fval="all" aria-pressed="true">All</button>
          <button class="fpill" data-for="tokens" data-fkey="kind" data-fval="sns" aria-pressed="false">SNS</button>
          <button class="fpill" data-for="tokens" data-fkey="kind" data-fval="ck" aria-pressed="false">ck tokens</button>
          <button class="fpill" data-for="tokens" data-fkey="kind" data-fval="community" aria-pressed="false">Community</button>
          <button class="fpill" data-for="tokens" data-fkey="hstate" data-fval="risk" aria-pressed="false" title="Tokens whose ledger, index, or archives are low, frozen, or at risk">Health risk</button>
          <a class="fpill" href="/watchlist">&#9733; Watchlist</a>
          <a class="fpill" href="/markets/screener">Screener</a>
          <a class="fpill" href="/portfolio">Portfolio</a>
        </div>
      </div>
      <TokenTable rows={rows} />
      <p class="note" style="margin-top:10px">
        Prices are liquidity-weighted across DEX pools. Supply is read from each ICRC ledger. The Health column comes from Lifeline: it reflects the worst state across a token's
        ledger, index, and archive canisters. <a class="link" href="/data-sources">Data sources</a>
      </p>
    </div>
  );
}

export function PoolsTable({ pools }: { pools: PoolRow[] }) {
  return (
    <div class="card tbl-wrap">
      <table class="tbl" id="pools" data-sortable>
        <thead>
          <tr>
            <th data-sort="text">Pool</th>
            <th data-sort="text">DEX</th>
            <th class="r" data-sort="num">TVL</th>
            <th class="r" data-sort="num" aria-sort="descending">24h volume</th>
            <th class="r hide-m" data-sort="num">7d volume</th>
            <th class="r hide-m" data-sort="num">Fee</th>
          </tr>
        </thead>
        <tbody>
          {pools.map((p) => (
            <tr data-search={`${p.symbol0} ${p.symbol1} ${p.dex}`} data-dex={p.dex}>
              <td data-v={`${p.symbol0}/${p.symbol1}`.toLowerCase()}>
                <span class="t" style="font-weight:600"><a href={`/token/${p.token0}`}>{p.symbol0 ?? "?"}</a> / <a href={`/token/${p.token1}`}>{p.symbol1 ?? "?"}</a></span>
                <span class="cid">{p.id.split(":").slice(1).join(":")}</span>
              </td>
              <td data-v={p.dex}>{p.dex}</td>
              <td class="r num" data-v={p.tvl_usd ?? ""}>{fmtCompact(p.tvl_usd, "$")}</td>
              <td class="r num strong" data-v={p.vol_24h_usd ?? ""}>{fmtCompact(p.vol_24h_usd, "$")}</td>
              <td class="r num hide-m" data-v={p.vol_7d_usd ?? ""}>{fmtCompact(p.vol_7d_usd, "$")}</td>
              <td class="r num hide-m" data-v={p.fee_bps ?? ""}>{p.fee_bps != null ? `${(p.fee_bps / 100).toFixed(2)}%` : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div data-empty-for="pools" hidden={pools.length > 0}><Empty>No pools yet.</Empty></div>
    </div>
  );
}
