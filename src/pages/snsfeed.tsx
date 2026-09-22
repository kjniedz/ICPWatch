// SNS proposal feed, unlock calendar, launches, and compare. All data from src/sns/feed.ts and queries.ts.
import type { Child } from "hono/jsx";
import { ago, fmtCompact, fmtNum, fmtUsd, shortDate, span } from "../lib/format";
import type { BigUnlock, FeedProposal, Launch, UnlockBucket } from "../sns/feed";
import type { SnsDaoView } from "../sns/queries";
import type { Grade } from "../trust/score";
import { Crumbs, Empty, Fresh, HealthPill, TokenLogo } from "../ui/components";
import { EntityName } from "./labels";
import { TrustBadge } from "./trust";
import type { EntityLabel } from "../labels";

const pct = (v: number | null | undefined, d = 0) => (v == null ? "n/a" : `${(v * 100).toFixed(d)}%`);
const DOT: Record<string, string> = { open: "d life", executed: "d ok", adopted: "d ok", rejected: "d risk", failed: "d frozen" };
const STATE: Record<string, string> = { open: "Open", executed: "Executed", adopted: "Adopted", rejected: "Rejected", failed: "Failed" };
const nnsHref = (root: string | null, id: number) => (root ? `https://nns.ic0.app/proposal/?u=${root}&proposal=${id}` : null);

export function ProposalCard({ p, showDao = true }: { p: FeedProposal; showDao?: boolean }) {
  const href = nnsHref(p.sns_root, p.id);
  const cast = (p.yes ?? 0) + (p.no ?? 0);
  const yesShare = cast ? (p.yes ?? 0) / cast : null;
  const turnout = p.total ? cast / p.total : null;
  return (
    <div class="feed-item prop">
      <span class={DOT[p.state] ?? "d ok"}></span>
      <div class="body">
        <div class="line">
          {showDao ? <a class="dao" href={`/token/${p.token_id}`}><TokenLogo id={p.token_id} symbol={p.symbol} logo={p.logo} /> {p.symbol}</a> : null}
          <span class="chip">{p.type}</span>
          {p.treasury_kind ? <span class="chip chip-warn">{p.treasury_kind === "mint" ? "mints" : "moves"} {fmtCompact(p.treasury_amount)} {p.treasury_kind === "icp" ? "ICP" : p.symbol}</span> : null}
          <span class={`state ${p.state}`}>{STATE[p.state] ?? p.state}</span>
        </div>
        <div class="title">{href ? <a href={href} rel="noopener">{p.title || `Proposal ${p.id}`}</a> : (p.title || `Proposal ${p.id}`)} <span class="muted">#{p.id}</span></div>
        <div class="meta">
          {p.created_at ? <span title={new Date(p.created_at * 1000).toISOString()}>{ago(p.created_at)}</span> : null}
          {yesShare != null ? <span><b class="up">{pct(yesShare)}</b> yes of votes cast</span> : <span class="muted">no votes yet</span>}
          {turnout != null ? <span>{pct(turnout, 1)} turnout</span> : null}
          {p.state === "open" && p.deadline_at ? <span>{p.deadline_at > Date.now() / 1000 ? `closes in ${span(p.deadline_at - Date.now() / 1000)}` : "past deadline"}</span> : null}
          {p.treasury_to ? <span>to <EntityName id={p.treasury_to} short /></span> : null}
          {p.url ? <a class="link" href={p.url} rel="noopener nofollow">forum</a> : null}
        </div>
      </div>
    </div>
  );
}

export function ProposalsFeedPage({ items, daos, filter, labels }: {
  items: FeedProposal[]; daos: { id: string; symbol: string; name: string }[]; filter: { dao: string; state: string; kind: string }; labels: Map<string, EntityLabel>;
}) {
  const qs = (over: Partial<typeof filter>, before?: number) => {
    const f = { ...filter, ...over };
    const parts = [f.dao ? `dao=${f.dao}` : "", f.state !== "all" ? `state=${f.state}` : "", f.kind !== "all" ? `kind=${f.kind}` : "", before ? `before=${before}` : ""].filter(Boolean);
    return `/sns/proposals${parts.length ? `?${parts.join("&")}` : ""}`;
  };
  const pill = (label: string, over: Partial<typeof filter>, active: boolean, title?: string) => <a class="fpill" href={qs(over)} aria-pressed={String(active)} title={title}>{label}</a>;
  const last = items[items.length - 1];
  void labels;
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Markets", "/markets"], ["SNS DAOs", "/sns"], ["Proposals", null]]} />
      <div class="page-head">
        <div>
          <h1>SNS proposals</h1>
          <p class="lede">Every proposal across every SNS DAO, newest first, read from each governance canister. Treasury transfers and mints are called out. <a class="link" href="/lifeline/alerts">Get an alert</a> the moment a DAO you hold opens one.</p>
        </div>
      </div>
      <div class="filters" style="margin-bottom:14px">
        {pill("All", { state: "all" }, filter.state === "all")}
        {pill("Open", { state: "open" }, filter.state === "open")}
        {pill("Decided", { state: "decided" }, filter.state === "decided")}
        <span class="sep"></span>
        {pill("Any type", { kind: "all" }, filter.kind === "all")}
        {pill("Treasury", { kind: "treasury" }, filter.kind === "treasury", "Transfers from or mints to the treasury")}
        {pill("Upgrades", { kind: "upgrade" }, filter.kind === "upgrade", "Dapp, SNS, and extension upgrades")}
        {pill("Motions", { kind: "motion" }, filter.kind === "motion")}
        <form method="get" action="/sns/proposals" style="display:contents">
          {filter.state !== "all" ? <input type="hidden" name="state" value={filter.state} /> : null}
          {filter.kind !== "all" ? <input type="hidden" name="kind" value={filter.kind} /> : null}
          <select class="input" name="dao" aria-label="DAO" onchange="this.form.submit()">
            <option value="">Every DAO</option>
            {daos.map((d) => <option value={d.id} selected={filter.dao === d.id}>{d.name} ({d.symbol})</option>)}
          </select>
        </form>
      </div>
      {items.length ? <div class="card">{items.map((p) => <ProposalCard p={p} />)}</div> : <div class="card"><Empty>No proposals match.</Empty></div>}
      {items.length >= 50 && last?.created_at ? <nav class="pager"><span></span><a class="btn btn-ghost" href={qs({}, last.created_at)}>Older &rarr;</a></nav> : null}
    </div>
  );
}

const monthName = (m: number) => new Date(Date.UTC(Math.floor(m / 100), (m % 100) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export function UnlocksPage({ buckets, big, locked, fetchedAt }: { buckets: UnlockBucket[]; big: BigUnlock[]; locked: { token_id: string; symbol: string; stake: number; neurons: number }[]; fetchedAt: number | null }) {
  const months = [...new Set(buckets.map((b) => b.month))].sort();
  const byMonth = new Map<number, UnlockBucket[]>();
  for (const b of buckets) byMonth.set(b.month, [...(byMonth.get(b.month) ?? []), b]);
  const usd = (b: UnlockBucket) => (b.price_usd != null ? b.stake * b.price_usd : 0);
  const monthUsd = months.map((m) => byMonth.get(m)!.reduce((s, b) => s + usd(b), 0));
  const maxUsd = Math.max(1, ...monthUsd);
  const totalUsd = monthUsd.reduce((s, v) => s + v, 0);
  return (
    <div class="wrap page" style="max-width:1100px">
      <Crumbs items={[["Markets", "/markets"], ["SNS DAOs", "/sns"], ["Unlock calendar", null]]} />
      <div class="page-head">
        <div>
          <h1>SNS unlock calendar</h1>
          <p class="lede">
            Neurons that are dissolving, by the month their stake becomes liquid. A developer neuron still vesting unlocks at the later of its dissolve and vesting dates. Neurons that are not dissolving have no date and are listed separately.
          </p>
        </div>
        <div class="page-actions"><Fresh ts={fetchedAt} source="governance list_neurons, full walk every 3 days" staleAfter={4 * 86400} label="walked" /></div>
      </div>

      <div class="card statbar">
        <div><div class="v c-amber">{fmtCompact(totalUsd, "$")}</div><div class="k">Unlocking in the next 12 months, at today's prices</div></div>
        <div><div class="v">{fmtNum(buckets.reduce((s, b) => s + b.neurons, 0))}</div><div class="k">Neurons with a date</div></div>
        <div><div class="v">{fmtNum(locked.reduce((s, l) => s + l.neurons, 0))}</div><div class="k">Neurons locked with no date</div></div>
      </div>

      <div class="sec-head"><h2>By month</h2></div>
      {months.length ? (
        <div class="card card-pad">
          {months.map((m, i) => (
            <div class="unlock-row">
              <div class="m">{monthName(m)}</div>
              <div class="bar"><b style={`width:${Math.max(1, Math.round((monthUsd[i]! / maxUsd) * 100))}%`}></b></div>
              <div class="v num">{fmtCompact(monthUsd[i], "$")}</div>
              <div class="d">
                {byMonth.get(m)!.slice(0, 6).map((b) => <a class="chip" href={`/token/${b.token_id}`} title={`${fmtNum(b.neurons)} neurons`}>{fmtCompact(b.stake)} {b.symbol}{b.price_usd != null ? ` (${fmtCompact(usd(b), "$")})` : ""}</a>)}
                {byMonth.get(m)!.length > 6 ? <span class="muted">+{byMonth.get(m)!.length - 6} more</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : <div class="card"><Empty>No dissolving neurons with a date in the next 12 months.</Empty></div>}

      <div class="sec-head"><h2>Largest single unlocks</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>When</th><th>DAO</th><th>Controller</th><th class="r">Stake</th><th class="r">At today's price</th><th class="hide-m">Neuron</th></tr></thead>
          <tbody>
            {big.map((u) => (
              <tr>
                <td>{shortDate(u.at)} <span class="cid">in {span(u.at - Date.now() / 1000)}</span></td>
                <td><a class="link" href={`/token/${u.token_id}`}>{u.symbol}</a>{u.from_nns_fund ? <span class="chip" title="Neurons Fund participation"> NF</span> : null}</td>
                <td>{u.controller ? <EntityName id={u.controller} short /> : <span class="muted">none</span>}</td>
                <td class="r num strong">{fmtCompact(u.stake)} {u.symbol}</td>
                <td class="r num">{u.price_usd != null ? fmtCompact(u.stake * u.price_usd, "$") : <span class="muted">n/a</span>}</td>
                <td class="mono hide-m" style="font-size:11px">{u.neuron_id.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="sec-head"><h2>Locked with no date</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>DAO</th><th class="r">Neurons</th><th class="r">Stake not dissolving</th></tr></thead>
          <tbody>{locked.map((l) => <tr><td><a class="link" href={`/token/${l.token_id}`}>{l.symbol}</a></td><td class="r num">{fmtNum(l.neurons)}</td><td class="r num">{fmtCompact(l.stake)} {l.symbol}</td></tr>)}</tbody>
        </table>
      </div>
      <div class="src" style="margin-top:10px">Stake includes staked maturity. Prices are today's aggregated DEX prices; nothing here predicts what holders will do once liquid.</div>
    </div>
  );
}

export function Launches({ items }: { items: Launch[] }) {
  if (!items.length) return <div class="card"><Empty>No swap is open or pending, and no SNS creation proposal has been submitted in the last 60 days.</Empty></div>;
  return (
    <div class="card">
      {items.map((l) => (
        <div class="feed-item">
          <span class={l.kind === "swap" && l.lifecycle === 2 ? "d life" : "d ok"}></span>
          <div class="body">
            <div class="title">
              {l.token_id ? <a href={`/token/${l.token_id}`}>{l.name}</a> : l.name}
              {" "}
              <span class="chip">{l.kind === "swap" ? (l.lifecycle === 2 ? "swap open" : "swap pending") : `NNS proposal ${l.status ?? ""}`}</span>
            </div>
            <div class="meta">
              {l.kind === "swap" ? (
                <>
                  {l.icp_raised != null ? <span><b>{fmtCompact(l.icp_raised)} ICP</b> raised{l.max_icp ? ` of ${fmtCompact(l.max_icp)} max` : ""}{l.min_icp ? `, ${fmtCompact(l.min_icp)} min` : ""}</span> : null}
                  {l.participants != null ? <span>{fmtNum(l.participants)} participants</span> : null}
                  {l.opens_at ? <span>opens {shortDate(l.opens_at)}</span> : null}
                  {l.closes_at ? <span>closes {shortDate(l.closes_at)}</span> : null}
                </>
              ) : (
                <>
                  <a class="link" href={`/proposal/${l.proposal_id}`}>Proposal {l.proposal_id}</a>
                  {l.created_at ? <span>submitted {ago(l.created_at)}</span> : null}
                  {l.closes_at && l.status === "open" ? <span>voting closes {shortDate(l.closes_at)}</span> : null}
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ComparePage({ all, picked }: { all: SnsDaoView[]; picked: SnsDaoView[] }) {
  const ids = picked.map((v) => v.row.id);
  const row = (label: string, cell: (v: SnsDaoView) => Child, title?: string) => (
    <tr><th title={title}>{label}</th>{picked.map((v) => <td class="r">{cell(v)}</td>)}</tr>
  );
  const best = (vals: (number | null)[], higher = true) => {
    const nums = vals.filter((x): x is number => x != null);
    if (nums.length < 2) return -1;
    const target = higher ? Math.max(...nums) : Math.min(...nums);
    return vals.indexOf(target);
  };
  const num = (label: string, get: (v: SnsDaoView) => number | null, fmt: (n: number) => string, higher = true, title?: string) => {
    const vals = picked.map(get);
    const b = best(vals, higher);
    return <tr><th title={title}>{label}</th>{vals.map((x, i) => <td class={`r num${i === b ? " best" : ""}`}>{x == null ? <span class="muted">n/a</span> : fmt(x)}</td>)}</tr>;
  };
  return (
    <div class="wrap page" style="max-width:1100px">
      <Crumbs items={[["Markets", "/markets"], ["SNS DAOs", "/sns"], ["Compare", null]]} />
      <div class="page-head">
        <div><h1>Compare DAOs</h1><p class="lede">Two to four SNS DAOs side by side. The best value in each row is highlighted.</p></div>
      </div>
      <form method="get" action="/sns/compare" class="card card-pad" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
        {[0, 1, 2, 3].map((i) => (
          <select class="input" name="dao" aria-label={`DAO ${i + 1}`}>
            <option value="">{i < 2 ? "Pick a DAO" : "Optional"}</option>
            {all.map((v) => <option value={v.row.id} selected={ids[i] === v.row.id}>{v.row.name} ({v.row.symbol})</option>)}
          </select>
        ))}
        <button class="btn btn-primary" type="submit">Compare</button>
      </form>
      {picked.length >= 2 ? (
        <div class="card tbl-wrap">
          <table class="tbl compare">
            <thead><tr><th></th>{picked.map((v) => <th class="r"><a class="name" href={`/token/${v.row.id}`}><TokenLogo id={v.row.id} symbol={v.row.symbol} logo={v.row.logo} /> <span>{v.row.name}</span></a></th>)}</tr></thead>
            <tbody>
              {row("Status", (v) => (v.dead ? <span class="chip chip-dead">dead</span> : <span class="chip">live</span>))}
              {num("Price", (v) => v.row.price_usd, (n) => fmtUsd(n))}
              {num("Market cap", (v) => v.row.mcap_usd, (n) => fmtCompact(n, "$"))}
              {num("Treasury", (v) => v.treasury_usd, (n) => fmtCompact(n, "$"))}
              {num("Treasury ICP", (v) => v.treasury_icp, (n) => `${fmtCompact(n)} ICP`)}
              {num("Treasury / market cap", (v) => v.treasury_of_mcap, (n) => pct(n), true, "Over 100% means the market values the DAO below its assets")}
              {num("Swap raised", (v) => v.row.swap_icp_raised, (n) => `${fmtCompact(n)} ICP`)}
              {num("Swap ROI", (v) => v.swap_roi, (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`)}
              {num("Neurons", (v) => v.neurons, (n) => fmtNum(n))}
              {num("Voting power", (v) => v.voting_power, (n) => fmtCompact(n))}
              {num("Proposals, 30 days", (v) => v.row.proposals_30d, (n) => fmtNum(n))}
              {num("Treasury proposals, 30 days", (v) => v.row.treasury_moves_30d, (n) => fmtNum(n), false)}
              {num("30-day turnout", (v) => v.row.turnout_30d, (n) => pct(n, 1))}
              {num("Pass rate", (v) => v.dao?.window?.pass_rate ?? null, (n) => pct(n))}
              {num("Trust score", (v) => v.row.trust_score, (n) => String(n))}
              {row("Trust grade", (v) => <TrustBadge grade={(v.row.trust_grade ?? "NA") as Grade} score={v.row.trust_score} />)}
              {row("Lifeline health", (v) => <HealthPill health={v.health} label={v.health_label} />)}
              {num("Canisters watched", (v) => v.row.canisters, (n) => fmtNum(n))}
              {row("Genesis", (v) => (v.dao?.genesis_at ? shortDate(v.dao.genesis_at) : <span class="muted">n/a</span>))}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>Pick at least two DAOs.</Empty></div>}
    </div>
  );
}
