// /sns: every SNS DAO on one page. The columns other trackers show, plus the ones only we can:
// trust score, Lifeline health across the whole DAO's canisters, and treasury movement counts.
import { fmtCompact, fmtNum, fmtPct, fmtUsd, pctClass, shortDate } from "../lib/format";
import type { SnsDaoView, SnsTotals } from "../sns/queries";
import type { Grade } from "../trust/score";
import { Crumbs, Fresh, HealthPill, TokenLogo } from "../ui/components";
import { TrustBadge } from "./trust";

const pct = (v: number | null | undefined, digits = 0) => (v == null ? "n/a" : `${(v * 100).toFixed(digits)}%`);

function Roi({ v }: { v: number | null }) {
  if (v == null) return <span class="muted">n/a</span>;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "";
  return <span class={`num ${cls}`} title="Current ICP value of 1 ICP put into the decentralization swap, minus 1">{v >= 0 ? "+" : ""}{(v * 100).toFixed(0)}%</span>;
}

export function SnsDashboardPage({ views, totals, fetchedAt }: { views: SnsDaoView[]; totals: SnsTotals; fetchedAt: number | null }) {
  return (
    <div class="wrap page" style="max-width:1400px">
      <Crumbs items={[["Markets", "/markets"], ["SNS DAOs", null]]} />
      <div class="page-head">
        <div>
          <h1>SNS DAOs</h1>
          <p class="lede">
            Every DAO launched through the NNS, live and dead. Treasuries are read from the governance canister's own accounts, proposals and neurons from each governance canister directly, prices from our DEX aggregation. Dead DAOs stay listed and are marked, because their tokens still trade.
          </p>
        </div>
        <div class="page-actions">
          <a class="btn btn-ghost" href="/sns/proposals">Proposal feed</a>
          <a class="btn btn-ghost" href="/sns/unlocks">Unlock calendar</a>
          <a class="btn btn-ghost" href="/sns/compare">Compare</a>
        </div>
      </div>

      <div class="card statbar">
        <div><div class="v">{fmtNum(totals.live)}<span class="muted" style="font-size:14px;font-weight:500"> / {fmtNum(totals.daos)}</span></div><div class="k">Live DAOs ({fmtNum(totals.dead)} dead)</div></div>
        <div><div class="v c-green">{fmtCompact(totals.treasury_usd, "$")}</div><div class="k">Treasuries, {fmtCompact(totals.treasury_icp)} ICP of it</div></div>
        <div><div class="v">{fmtCompact(totals.mcap_usd, "$")}</div><div class="k">Combined market cap</div></div>
        <div><div class="v c-amber">{fmtNum(totals.under_treasury)}</div><div class="k">Valued below treasury</div></div>
        <div><div class="v">{fmtCompact(totals.neurons)}</div><div class="k">Neurons</div></div>
        <div><div class="v">{fmtNum(totals.proposals_30d)}</div><div class="k">Proposals, 30 days ({fmtNum(totals.open_now)} open)</div></div>
        <div><div class="v">{fmtCompact(totals.icp_raised)} ICP</div><div class="k">Raised in swaps, all time</div></div>
        <div class="meta"><Fresh ts={fetchedAt} source="SNS governance + ledgers + DEX prices" staleAfter={7200} label="read" /></div>
      </div>

      <div class="sec-head" style="margin-top:16px">
        <h2>All DAOs <span class="muted" style="font-weight:500;font-size:12px">&nbsp;<span data-count-for="sns">{views.length}</span> shown</span></h2>
        <div class="filters">
          <input class="input" type="search" placeholder="Filter DAOs" data-filter-for="sns" aria-label="Filter DAOs" />
          <button class="fpill" data-for="sns" data-fkey="state" data-fval="all" aria-pressed="true">All</button>
          <button class="fpill" data-for="sns" data-fkey="state" data-fval="live" aria-pressed="false">Live</button>
          <button class="fpill" data-for="sns" data-fkey="state" data-fval="dead" aria-pressed="false" title="Governance or ledger frozen, uninstalled, or not answering for two days">Dead</button>
          <button class="fpill" data-for="sns" data-fkey="state" data-fval="cheap" aria-pressed="false" title="Market cap below treasury value">Below treasury</button>
          <button class="fpill" data-for="sns" data-fkey="state" data-fval="active" aria-pressed="false" title="At least one proposal in the last 30 days">Active</button>
        </div>
      </div>

      <div class="card tbl-wrap">
        <table class="tbl" id="sns" data-sortable>
          <thead>
            <tr>
              <th class="hide-m" style="width:36px">#</th>
              <th data-sort="text">DAO</th>
              <th class="r" data-sort="num">Price</th>
              <th class="r hide-m" data-sort="num">24h</th>
              <th class="r" data-sort="num" aria-sort="descending">Market cap</th>
              <th class="r hide-m" data-sort="num">FDV</th>
              <th class="r" data-sort="num">Treasury</th>
              <th class="r" data-sort="num" title="Treasury value divided by market cap. Over 100% means the market values the DAO below the assets it holds.">Treasury / mcap</th>
              <th class="r hide-m" data-sort="num" title="Current ICP value of 1 ICP put into the swap, minus 1">Swap ROI</th>
              <th class="r hide-m" data-sort="num">Neurons</th>
              <th class="r hide-m" data-sort="num" title="Total potential voting power in tokens, all bonuses applied">Voting power</th>
              <th class="r hide-m" data-sort="num" title="Average share of voting power cast on proposals decided in the last 30 days">30d turnout</th>
              <th class="r" data-sort="num" title="Proposals created in the last 30 days, treasury transfers or mints among them in brackets">Proposals 30d</th>
              <th data-sort="num">Trust</th>
              <th data-sort="text">Health</th>
            </tr>
          </thead>
          <tbody>
            {views.map((v, i) => {
              const r = v.row;
              return (
                <tr class={v.dead ? "dead" : undefined} data-search={`${r.symbol} ${r.name} ${r.id} ${r.sns_root ?? ""}`}
                  data-state={[v.dead ? "dead" : "live", v.treasury_of_mcap != null && v.treasury_of_mcap > 1 ? "cheap" : "", r.proposals_30d ? "active" : ""].filter(Boolean).join(" ")}>
                  <td class="muted hide-m">{i + 1}</td>
                  <td data-v={r.name.toLowerCase()}>
                    <a class="name" href={`/token/${r.id}`}>
                      <TokenLogo id={r.id} symbol={r.symbol} logo={r.logo} />
                      <span>
                        <span class="t">{r.name}</span>
                        <span class="sub">{r.symbol}{v.dead ? <span class="chip chip-dead" title={v.dead_reason ?? "No live reads"}> dead</span> : null}{r.swap_lifecycle === 2 ? <span class="chip"> swap open</span> : null}</span>
                      </span>
                    </a>
                  </td>
                  <td class="r num strong" data-v={r.price_usd ?? ""}>{fmtUsd(r.price_usd)}</td>
                  <td class="r hide-m" data-v={r.chg_24h ?? ""}><span class={`num ${pctClass(r.chg_24h)}`}>{fmtPct(r.chg_24h)}</span></td>
                  <td class="r num" data-v={r.mcap_usd ?? ""}>{fmtCompact(r.mcap_usd, "$")}</td>
                  <td class="r num hide-m" data-v={r.fdv_usd ?? ""}>{fmtCompact(r.fdv_usd, "$")}</td>
                  <td class="r num" data-v={v.treasury_usd ?? ""}>
                    {v.treasury_usd != null ? <b>{fmtCompact(v.treasury_usd, "$")}</b> : <span class="muted">n/a</span>}
                    {v.treasury_icp != null ? <span class="cid">{fmtCompact(v.treasury_icp)} ICP{v.treasury_token ? ` + ${fmtCompact(v.treasury_token)} ${r.symbol}` : ""}</span> : null}
                  </td>
                  <td class="r num" data-v={v.treasury_of_mcap ?? ""}>
                    {v.treasury_of_mcap == null ? <span class="muted">n/a</span> : <span class={v.treasury_of_mcap > 1 ? "c-amber" : undefined}>{pct(v.treasury_of_mcap)}</span>}
                  </td>
                  <td class="r hide-m" data-v={v.swap_roi ?? ""}><Roi v={v.swap_roi} /></td>
                  <td class="r num hide-m" data-v={v.neurons ?? ""}>{v.neurons != null ? fmtNum(v.neurons) : <span class="muted">n/a</span>}</td>
                  <td class="r num hide-m" data-v={v.voting_power ?? ""}>{v.voting_power != null ? fmtCompact(v.voting_power) : <span class="muted">n/a</span>}</td>
                  <td class="r num hide-m" data-v={r.turnout_30d ?? ""}>{r.turnout_30d != null ? pct(r.turnout_30d, 1) : <span class="muted">none decided</span>}</td>
                  <td class="r num" data-v={r.proposals_30d}>
                    {fmtNum(r.proposals_30d)}
                    {r.treasury_moves_30d ? <span class="c-amber" title="treasury transfers or mints proposed"> ({r.treasury_moves_30d})</span> : null}
                    {r.open_now ? <span class="cid">{r.open_now} open</span> : null}
                  </td>
                  <td data-v={r.trust_score ?? -1}><a href={`/token/${r.id}#trust`}><TrustBadge grade={(r.trust_grade ?? "NA") as Grade} score={r.trust_score} /></a></td>
                  <td data-v={v.health}><a href={`/token/${r.id}#health`}><HealthPill health={v.health} label={v.health_label} /></a><span class="cid">{r.canisters} canisters</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div class="src" style="margin-top:10px">
        Treasury: governance canister's ICP account and token-distribution subaccount, valued at our aggregated DEX prices. Swap ROI uses the swap's final tokens-per-ICP rate. Neurons and voting power: governance canister metrics. Turnout and proposal counts: our own proposal index, read from each governance canister. Trust: <a class="link" href="/trust-score">method 1.0</a>. Health: worst Lifeline state across every canister the SNS root reports.
      </div>

      <div class="sec-head" style="margin-top:28px"><h2>Recent swaps</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>DAO</th><th>Closed</th><th class="r">Raised</th><th class="r hide-m">Direct / NNS fund</th><th class="r hide-m">Participants</th><th class="r">Swap ROI</th></tr></thead>
          <tbody>
            {[...views].filter((v) => v.row.swap_icp_raised).sort((a, b) => (b.row.swap_closed_at ?? 0) - (a.row.swap_closed_at ?? 0)).slice(0, 12).map((v) => (
              <tr>
                <td><a class="link" href={`/token/${v.row.id}`}>{v.row.name}</a></td>
                <td>{v.row.swap_closed_at ? shortDate(v.row.swap_closed_at) : <span class="muted">open</span>}</td>
                <td class="r num">{fmtCompact(v.row.swap_icp_raised)} ICP</td>
                <td class="r num hide-m">{fmtCompact(v.row.swap_direct_icp)} / {fmtCompact(v.row.swap_nf_icp)}</td>
                <td class="r num hide-m">{fmtNum(v.row.swap_participants)}</td>
                <td class="r"><Roi v={v.swap_roi} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
