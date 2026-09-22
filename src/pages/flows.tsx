// /markets/exchange-flows and /markets/decentralization: nightly tables from src/flows.
import type { DecTable, FlowsTable } from "../flows";
import { fmtCompact, fmtNum, shortDate } from "../lib/format";
import { Crumbs, Empty, Fresh, TokenLogo } from "../ui/components";
import { EntityName } from "./labels";

const signed = (v: number) => <span class={`num ${v > 0 ? "down" : v < 0 ? "up" : ""}`} title={v > 0 ? "net into hubs (selling pressure)" : "net out of hubs (withdrawals)"}>{v > 0 ? "+" : v < 0 ? "-" : ""}{fmtCompact(Math.abs(v), "$")}</span>;

export function FlowsPage({ t }: { t: FlowsTable | null }) {
  const days = t?.icp_daily.slice(-60) ?? [];
  const max = Math.max(1, ...days.map((d) => Math.max(d.in_usd, d.out_usd)));
  return (
    <div class="wrap page" style="max-width:1100px">
      <Crumbs items={[["Markets", "/markets"], ["Exchange flows", null]]} />
      <div class="page-head">
        <div>
          <h1>Exchange flows</h1>
          <p class="lede">Large transfers into and out of exchange and custodian accounts. Inflows are usually coins heading to a sell order; outflows are withdrawals to self custody. No ICP exchange publishes its account ids in a citable place, so most hubs here are <b>inferred</b> from traffic in our own index: accounts that both receive from and send to at least 60 distinct counterparties in a year. They are shown as inferred, not as facts.</p>
        </div>
        <div class="page-actions"><Fresh ts={t?.computed_at ?? null} source="ICPWatch block index (large transfers) + entity labels" staleAfter={2 * 86400} label="computed" /></div>
      </div>
      {!t ? <div class="card"><Empty>The nightly flow computation has not run yet.</Empty></div> : (
        <>
          <div class="sec-head"><h2>ICP, daily</h2><span class="note">last 60 days, USD at today's price, <i class="sw" style="background:var(--down)"></i> into hubs <i class="sw" style="background:var(--up)"></i> out of hubs</span></div>
          <div class="card card-pad">
            {days.length ? (
              <svg viewBox={`0 0 ${days.length * 10} 120`} width="100%" height="140" preserveAspectRatio="none" role="img" aria-label="Daily exchange inflow and outflow">
                {days.map((d, i) => (
                  <>
                    <rect x={i * 10 + 1} y={60 - (d.in_usd / max) * 58} width="4" height={(d.in_usd / max) * 58} fill="var(--down)"><title>{shortDate(d.day)}: in {fmtCompact(d.in_usd, "$")}</title></rect>
                    <rect x={i * 10 + 5} y={60 - (d.out_usd / max) * 58} width="4" height={(d.out_usd / max) * 58} fill="var(--up)"><title>{shortDate(d.day)}: out {fmtCompact(d.out_usd, "$")}</title></rect>
                    <rect x={i * 10 + 1} y="62" width="8" height={Math.min(56, (Math.abs(d.in_usd - d.out_usd) / max) * 56)} fill={d.in_usd >= d.out_usd ? "var(--down)" : "var(--up)"} opacity="0.35"><title>{shortDate(d.day)}: net {d.in_usd >= d.out_usd ? "in" : "out"} {fmtCompact(Math.abs(d.in_usd - d.out_usd), "$")}</title></rect>
                  </>
                ))}
              </svg>
            ) : <Empty>No hub traffic on the ICP ledger in the window.</Empty>}
            <div class="src">Top row: gross in and out per day. Bottom row: the net, colored by direction.</div>
          </div>

          <div class="sec-head"><h2>By token</h2><span class="note">net into hubs; positive is selling pressure</span></div>
          <div class="card tbl-wrap">
            <table class="tbl" data-sortable>
              <thead><tr><th data-sort="text">Token</th><th class="r" data-sort="num">24h</th><th class="r" data-sort="num" aria-sort="descending">7d</th><th class="r" data-sort="num">30d</th><th class="r hide-m" data-sort="num">In 30d</th><th class="r hide-m" data-sort="num">Out 30d</th></tr></thead>
              <tbody>{t.tokens.map((x) => <tr><td data-v={x.symbol}><a class="link" href={`/token/${x.token_id}`}>{x.symbol}</a></td><td class="r" data-v={x.net_24h}>{signed(x.net_24h)}</td><td class="r" data-v={x.net_7d}>{signed(x.net_7d)}</td><td class="r" data-v={x.net_30d}>{signed(x.net_30d)}</td><td class="r num hide-m" data-v={x.in_30d}>{fmtCompact(x.in_30d, "$")}</td><td class="r num hide-m" data-v={x.out_30d}>{fmtCompact(x.out_30d, "$")}</td></tr>)}</tbody>
            </table>
          </div>

          <div class="sec-head"><h2>Hubs</h2><span class="note">{fmtNum(t.hubs.length)} accounts</span></div>
          <div class="card tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Account</th><th>Basis</th><th class="r hide-m">Senders</th><th class="r hide-m">Receivers</th></tr></thead>
              <tbody>{t.hubs.map((h) => <tr><td><EntityName id={h.account} label={h.label ? { id: h.account, name: h.label, category: "exchange", confidence: h.confidence, source: "" } as never : null} short /></td><td>{h.confidence === "inferred" && !h.label ? <span class="chip chip-warn">inferred hub</span> : <span class="chip">{h.confidence} label</span>}</td><td class="r num hide-m">{fmtNum(h.in_counterparties)}</td><td class="r num hide-m">{fmtNum(h.out_counterparties)}</td></tr>)}</tbody>
            </table>
          </div>
          <div class="src" style="margin-top:10px">Know which exchange an account belongs to? <a class="link" href="/labels/submit">Submit the evidence</a>; a cited label upgrades the row from inferred to named.</div>
        </>
      )}
    </div>
  );
}

const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

export function DecentralizationPage({ t }: { t: DecTable | null }) {
  return (
    <div class="wrap page" style="max-width:1100px">
      <Crumbs items={[["Markets", "/markets"], ["Decentralization", null]]} />
      <div class="page-head">
        <div>
          <h1>Decentralization</h1>
          <p class="lede">How spread out each token really is, from ICPWatch's reconciled ledger index: holders, the top-10 share, the Gini coefficient, and the Nakamoto coefficient (fewest accounts that together hold a majority). For SNS DAOs, the share of voting power held by the five biggest neuron controllers, from the neuron walk.</p>
        </div>
        <div class="page-actions"><Fresh ts={t?.computed_at ?? null} source="ICPWatch block index + SNS neuron walk" staleAfter={2 * 86400} label="computed" /></div>
      </div>
      {!t?.rows.length ? <div class="card"><Empty>The nightly computation has not run yet.</Empty></div> : (
        <div class="card tbl-wrap">
          <table class="tbl" data-sortable>
            <thead><tr><th data-sort="text">Token</th><th class="r" data-sort="num">Holders</th><th class="r" data-sort="num">Top 10</th><th class="r hide-m" data-sort="num" title="0 equal, 1 one account has it all">Gini</th><th class="r" data-sort="num" aria-sort="descending" title="Fewest accounts holding a majority; higher is better">Nakamoto</th><th class="r hide-m" data-sort="num" title="Share of SNS voting power held by the top 5 controllers">Top 5 VP</th><th class="r hide-m" data-sort="num">Market cap</th></tr></thead>
            <tbody>
              {t.rows.map((r) => (
                <tr>
                  <td data-v={r.symbol}><a class="name" href={`/token/${r.token_id}/holders`}><TokenLogo id={r.token_id} symbol={r.symbol} logo={r.logo} /><span><span class="t">{r.symbol}</span><span class="sub">{r.name}</span></span></a></td>
                  <td class="r num" data-v={r.holders}>{fmtNum(r.holders)}</td>
                  <td class="r num" data-v={r.top10 ?? ""}>{pct(r.top10)}</td>
                  <td class="r num hide-m" data-v={r.gini ?? ""}>{r.gini != null ? r.gini.toFixed(3) : "n/a"}</td>
                  <td class="r num" data-v={r.nakamoto ?? ""}>{r.nakamoto != null ? (r.nakamoto >= 1000 ? "1000+" : String(r.nakamoto)) : "n/a"}</td>
                  <td class="r num hide-m" data-v={r.vp_top5 ?? ""}>{r.vp_top5 != null ? <span class={r.vp_top5 > 0.5 ? "c-amber" : undefined}>{pct(r.vp_top5)}</span> : <span class="muted">not SNS</span>}</td>
                  <td class="r num hide-m" data-v={r.mcap_usd ?? ""}>{fmtCompact(r.mcap_usd, "$")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div class="src" style="margin-top:10px">Holder metrics count ledger accounts, so a DEX pool or an SNS treasury is one account; open a token's holders page for the entity breakdown and the look-through view. Only ledgers whose index has reconciled exactly against total supply appear here.</div>
    </div>
  );
}
