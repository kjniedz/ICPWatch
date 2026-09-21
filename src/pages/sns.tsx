// Richer "SNS DAO" section for the token page. Takes the kv value written by src/collectors/sns.ts
// (key `sns:<ledgerId>`). Every field beyond the original SnsInfo shape is optional here, so rows
// written by an older collector still render.
import { ago, fmtCompact, fmtNum, fmtUsd, isoDate, shortDate, span } from "../lib/format";
import type { SnsDao, SnsProposal } from "../lib/sns";
import { Fresh } from "../ui/components";

export type SnsSectionData = Pick<SnsDao, "treasury_icp" | "treasury_token" | "open_proposals" | "neurons"> &
  Partial<Omit<SnsDao, "proposals">> & { proposals: (Pick<SnsProposal, "id" | "title" | "status"> & Partial<SnsProposal>)[]; fetched_at: number; source: string };

const pct = (v: number | null | undefined, digits = 0) => (v == null ? "n/a" : `${(v * 100).toFixed(digits)}%`);

const DOT: Record<string, string> = { open: "d life", executed: "d ok", adopted: "d ok", rejected: "d risk", failed: "d frozen" };

export function SnsDaoSection({ sns, symbol }: { sns: SnsSectionData; symbol: string }) {
  const w = sns.window;
  const spent = sns.treasury_icp != null && sns.treasury_icp_original ? 1 - sns.treasury_icp / sns.treasury_icp_original : null;
  const windowSpan = w?.from_ts && w.to_ts ? span(w.to_ts - w.from_ts) : null;
  const proposalHref = (id: number) => (sns.root ? `https://nns.ic0.app/proposal/?u=${sns.root}&proposal=${id}` : null);
  return (
    <>
      <div class="sec-head"><h2>SNS DAO</h2><Fresh ts={sns.fetched_at} source={sns.source} staleAfter={7200} /></div>
      <div class="card kv">
        <div>
          <div class="k">Treasury value</div>
          <div class="v">{sns.treasury_usd != null ? fmtCompact(sns.treasury_usd, "$") : "n/a"}</div>
          <div class="s">ICP plus {symbol} at our aggregated prices</div>
        </div>
        <div>
          <div class="k">ICP treasury</div>
          <div class="v">{sns.treasury_icp != null ? `${fmtCompact(sns.treasury_icp)} ICP` : "n/a"}</div>
          <div class="s">
            {sns.treasury_icp_usd != null ? fmtUsd(sns.treasury_icp_usd) : ""}
            {spent != null && spent > 0.001 ? `${sns.treasury_icp_usd != null ? " · " : ""}${pct(spent)} of the ${fmtCompact(sns.treasury_icp_original)} ICP raised has left this account` : ""}
          </div>
        </div>
        <div>
          <div class="k">{symbol} treasury</div>
          <div class="v">{sns.treasury_token != null ? `${fmtCompact(sns.treasury_token)} ${symbol}` : "n/a"}</div>
          <div class="s">{sns.treasury_token_usd != null ? `${fmtUsd(sns.treasury_token_usd)} if it could be sold at the current price` : ""}</div>
        </div>
        <div>
          <div class="k">Neurons</div>
          <div class="v">{fmtNum(sns.neurons)}</div>
          <div class="s">{sns.neurons_source ?? ""}</div>
        </div>
        <div>
          <div class="k">Open proposals</div>
          <div class="v">{fmtNum(sns.open_proposals)}</div>
          <div class="s">{sns.submitted_30d != null ? `${fmtNum(sns.submitted_30d)} submitted, ${fmtNum(sns.executed_30d)} executed in 30 days` : ""}</div>
        </div>
        {w ? (
          <>
            <div>
              <div class="k">Passed / rejected</div>
              <div class="v"><span class="up">{w.passed}</span> / <span class="down">{w.rejected}</span></div>
              <div class="s">latest {w.size} proposals{windowSpan ? `, spanning ${windowSpan}` : ""}{w.failed ? `, ${w.failed} failed to execute` : ""}</div>
            </div>
            <div>
              <div class="k">Pass rate</div>
              <div class="v">{pct(w.pass_rate)}</div>
              <div class="s">of decided proposals in that window</div>
            </div>
            <div>
              <div class="k">Voting participation</div>
              <div class="v">{pct(w.participation_avg)}</div>
              <div class="s">average share of voting power that voted, followers included</div>
            </div>
          </>
        ) : null}
      </div>
      {sns.missing?.length ? <div class="src" style="margin-top:8px">Some reads did not answer this hour: {sns.missing.join(", ").replace(/_/g, " ")}.</div> : null}

      {sns.proposals.length ? (
        <div class="card" style="margin-top:12px">
          {sns.proposals.map((p) => {
            const href = proposalHref(p.id);
            return (
              <div class="feed-item" style="border-bottom:1px solid var(--border)">
                <span class={DOT[p.state ?? ""] ?? "d ok"}></span>
                <div style="min-width:0">
                  <h4>{href ? <a href={href} rel="noopener nofollow">{p.title}</a> : p.title}</h4>
                  <small>
                    #{p.id} &middot; {p.status}{p.type ? <> &middot; {p.type}</> : null}
                    {p.yes_share != null ? <> &middot; {pct(p.yes_share, 1)} yes</> : null}
                    {p.participation != null ? <> &middot; {pct(p.participation)} turnout</> : null}
                    {p.created_at ? <> &middot; <time datetime={isoDate(p.created_at)} title={shortDate(p.created_at)}>{ago(p.created_at)}</time></> : null}
                  </small>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <p class="note" style="margin-top:10px">
        Treasury balances are read from the ICP ledger and the {symbol} ledger. Proposal titles are written by whoever submitted them and are shown as they appear on chain, so treat links and offers in them with care.
        Neuron dissolve and unlock schedules are not shown: SNS governance does not publish them in aggregate.
      </p>
    </>
  );
}
