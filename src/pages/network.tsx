import type { Kv, ProposalRow, SubnetRow } from "../db/queries";
import { ago, fmtBytes, fmtCompact, fmtCycles, fmtNum, isoDate, now, shortDate, shortId, span } from "../lib/format";
import { CopyId, Crumbs, Empty, Fresh } from "../ui/components";

export interface NetworkStats {
  block_rate: number | null; subnets: number | null; canisters: number | null; burn_per_day: number | null;
  nodes: number | null; node_providers: number | null; tx_rate: number | null; icp_supply: number | null;
}

const topicClass = (topic: string | null) => {
  const t = (topic ?? "").toLowerCase();
  if (t.includes("govern") || t.includes("subnet") || t.includes("node") || t.includes("participant")) return "t-gov";
  if (t.includes("econom") || t.includes("exchange") || t.includes("reward")) return "t-econ";
  if (t.includes("motion")) return "t-motion";
  if (t.includes("sns")) return "t-sns";
  return "";
};

/** "TOPIC_IC_OS_VERSION_ELECTION" and friends become "IC OS version election". */
export function topicLabel(topic: string | null): string {
  if (!topic) return "Proposal";
  const s = topic.replace(/^TOPIC_/, "").replace(/_/g, " ").toLowerCase();
  return s.replace(/\bic os\b/, "IC-OS").replace(/\bsns\b/, "SNS").replace(/\bnns\b/, "NNS").replace(/\bkyc\b/, "KYC").replace(/\bapi\b/, "API").replace(/^./, (c) => c.toUpperCase());
}

export function statusLabel(p: ProposalRow, nowTs = now()): string {
  const st = (p.status ?? "").replace(/^PROPOSAL_STATUS_/, "").toLowerCase();
  if (st === "open") return p.deadline_at && p.deadline_at > nowTs ? `Open · ${span(p.deadline_at - nowTs)} left` : "Open";
  if (st === "executed") return "Adopted and executed";
  if (st === "adopted") return "Adopted";
  if (st === "rejected") return "Rejected";
  if (st === "failed") return "Adopted, execution failed";
  return st || "Unknown";
}

export function yesShare(p: ProposalRow): number | null {
  if (p.yes == null || p.no == null) return null;
  const cast = p.yes + p.no;
  if (cast <= 0) return 0;
  return p.yes / cast;
}

export function ProposalItem({ p }: { p: ProposalRow }) {
  const y = yesShare(p);
  return (
    <a class="card prop" href={`/proposal/${p.id}`}>
      <span class={`topic ${topicClass(p.topic)}`}>{topicLabel(p.topic).split(" ")[0]}</span>
      <div class="b">
        <h4>{p.title || `Proposal ${p.id}`}</h4>
        <small>#{p.id} &middot; {statusLabel(p)}</small>
      </div>
      <div class="tally" title="Share of votes cast so far that are yes">
        <div class="bar"><b style={`width:${Math.round((y ?? 0) * 100)}%`}></b></div>
        <span class="num">{y == null ? "n/a" : `${Math.round(y * 100)}% yes`}</span>
      </div>
    </a>
  );
}

export function SubnetItem({ s, maxBurn }: { s: SubnetRow; maxBurn: number }) {
  const rel = s.burn_per_day != null && maxBurn > 0 ? s.burn_per_day / maxBurn : null;
  return (
    <a class="card subnet" href={`/subnet/${s.id}`}>
      <div class="r1">
        <b>{shortId(s.id)}</b>
        <small>{s.label ?? s.type ?? "subnet"} &middot; {s.nodes ?? "?"} nodes</small>
      </div>
      <div class="r2">
        <span>burn <b>{s.burn_per_day != null ? `${fmtCycles(s.burn_per_day)}/d` : "n/a"}</b></span>
        <span>canisters <b>{fmtCompact(s.canisters)}</b></span>
        {s.block_rate != null ? <span>blocks <b>{s.block_rate.toFixed(2)}/s</b></span> : null}
        {rel != null ? <span class="bar" style="flex:1;align-self:center;min-width:60px" title="Burn relative to the hottest subnet"><b style={`width:${Math.max(3, Math.round(rel * 100))}%`}></b></span> : null}
      </div>
    </a>
  );
}

/** A grid of small time-series charts sharing one range selector. `subnet` scopes every chart to one subnet. */
export function NetworkCharts({ group, charts, subnet }: { group: string; charts: [string, string, string][]; subnet?: string }) {
  const ranges = ["24h", "7d", "30d", "90d", "1y"];
  return (
    <section>
      <div class="sec-head">
        <h2>{subnet ? "Subnet activity" : "Network activity"}</h2>
        <div class="filters" data-chart-group={group}>
          {ranges.map((r) => <button type="button" class="fpill" data-range={r} aria-pressed={String(r === "30d")}>{r.toUpperCase()}</button>)}
        </div>
      </div>
      <div class="grid-2" style="gap:16px">
        {charts.map(([metric, title, sub]) => (
          <div class="card">
            <div style="padding:14px 18px 0"><h3 style="font-size:13.5px;font-weight:700">{title}</h3><div class="src">{sub}</div></div>
            <div class="chart-box sm" id={`${group}-${metric}`} data-group={group} data-range="30d" data-chart={`/api/v1/network/series?metric=${metric}${subnet ? `&subnet=${subnet}` : ""}`}></div>
          </div>
        ))}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><span class="src">Source: <b>IC public API</b> (third party, DFINITY). These rates have no on-chain source.</span></div>
    </section>
  );
}

export function NetworkPage({ stats, subnets, proposals }: { stats: Kv<NetworkStats> | null; subnets: SubnetRow[]; proposals: ProposalRow[] }) {
  const s = stats?.value;
  const maxBurn = Math.max(0, ...subnets.map((x) => x.burn_per_day ?? 0));
  return (
    <div class="wrap page" style="max-width:1100px">
      <section class="search-hero">
        <h1>Network</h1>
        <p>One box for everything: canisters, principals, accounts, tokens, subnets, proposals.</p>
        <form class="bigsearch" action="/search" method="get" role="search" data-search>
          <input type="search" name="q" placeholder="ryjl3-tyaaa..., proposal 134992, subnet tdb26, &quot;openchat&quot;" autocomplete="off" spellcheck={false} aria-label="Search the Internet Computer" autofocus />
        </form>
      </section>

      <div class="stats" style="margin-top:34px">
        <div class="card stat center"><div class="v c-blue">{s?.block_rate != null ? fmtNum(s.block_rate, 1) : "n/a"}</div><div class="k">Blocks / s</div></div>
        <div class="card stat center"><div class="v">{fmtNum(s?.subnets)}</div><div class="k">Subnets</div></div>
        <div class="card stat center"><div class="v">{fmtCompact(s?.canisters)}</div><div class="k">Canisters</div></div>
        <div class="card stat center"><div class="v c-pink">{s?.burn_per_day != null ? fmtCycles(s.burn_per_day) : "n/a"}</div><div class="k">Cycles burned / day</div></div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><Fresh ts={stats?.fetched_at} source={stats?.source ?? "IC metrics API"} staleAfter={5400} /></div>

      <NetworkCharts group="net" charts={[["blocks", "Block rate", "blocks finalized per second, all subnets"], ["burn", "Cycles burned per day", "network-wide burn rate"], ["messages", "Messages executed", "queries and updates per second"], ["canisters", "Canisters", "running plus stopped"]]} />

      <div class="grid-2" style="margin-top:6px">
        <section>
          <div class="sec-head"><h2>Hottest subnets by cycle burn</h2><a class="link" style="font-size:12px" href="/network/subnets">All subnets</a></div>
          {subnets.length ? <div class="stack">{subnets.slice(0, 6).map((x) => <SubnetItem s={x} maxBurn={maxBurn} />)}</div> : <div class="card"><Empty>Waiting for the first network run.</Empty></div>}
        </section>
        <section>
          <div class="sec-head"><h2>Governance, readable</h2><a class="link" style="font-size:12px" href="/network/proposals">All proposals</a></div>
          {proposals.length ? <div class="stack">{proposals.slice(0, 6).map((p) => <ProposalItem p={p} />)}</div> : <div class="card"><Empty>Waiting for the first governance run.</Empty></div>}
        </section>
      </div>
    </div>
  );
}

export function SubnetsPage({ subnets, fetchedAt }: { subnets: SubnetRow[]; fetchedAt: number | null }) {
  return (
    <div class="wrap page">
      <Crumbs items={[["Network", "/network"], ["Subnets", null]]} />
      <div class="page-head">
        <div><h1>Subnets</h1><p class="lede">Every subnet ranked by cycle burn, with size, throughput, and state.</p></div>
        <Fresh ts={fetchedAt} source="IC metrics API" staleAfter={5400} />
      </div>
      <div class="card tbl-wrap">
        <table class="tbl" id="subnets" data-sortable>
          <thead><tr>
            <th data-sort="text">Subnet</th><th data-sort="text">Type</th><th class="r" data-sort="num">Nodes</th><th class="r" data-sort="num">Canisters</th>
            <th class="r" data-sort="num" aria-sort="descending">Burn / day</th><th class="r hide-m" data-sort="num">Blocks / s</th><th class="r hide-m" data-sort="num">State</th>
          </tr></thead>
          <tbody>
            {subnets.map((s) => (
              <tr>
                <td data-v={s.id}><a href={`/subnet/${s.id}`} class="mono" style="font-weight:600;font-size:12.5px">{shortId(s.id)}</a></td>
                <td data-v={s.label ?? s.type ?? ""}>{s.label ?? s.type ?? "n/a"}</td>
                <td class="r num" data-v={s.nodes ?? ""}>{fmtNum(s.nodes)}</td>
                <td class="r num" data-v={s.canisters ?? ""}>{fmtNum(s.canisters)}</td>
                <td class="r num strong" data-v={s.burn_per_day ?? ""}>{s.burn_per_day != null ? fmtCycles(s.burn_per_day) : "n/a"}</td>
                <td class="r num hide-m" data-v={s.block_rate ?? ""}>{s.block_rate != null ? s.block_rate.toFixed(2) : "n/a"}</td>
                <td class="r num hide-m" data-v={s.memory_bytes ?? ""}>{fmtBytes(s.memory_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div data-empty-for="subnets" hidden={subnets.length > 0}><Empty>Waiting for the first network run.</Empty></div>
      </div>
    </div>
  );
}

export function SubnetPage({ s, watched }: { s: SubnetRow; watched: { id: string; label: string; burn_per_day: number | null; cycles: number | null; health: string }[] }) {
  return (
    <div class="wrap page">
      <Crumbs items={[["Network", "/network"], ["Subnets", "/network/subnets"], [shortId(s.id), null]]} />
      <div class="detail-head">
        <h1>Subnet <span class="mono" style="font-size:18px">{shortId(s.id)}</span></h1>
        <Fresh ts={s.updated_at} source="IC metrics API" staleAfter={5400} />
      </div>
      <div class="card kv">
        <div><div class="k">Subnet id</div><div class="v mono">{s.id} <CopyId id={s.id} /></div></div>
        <div><div class="k">Type</div><div class="v">{s.label ?? s.type ?? "n/a"}</div></div>
        <div><div class="k">Nodes</div><div class="v">{fmtNum(s.nodes)}</div></div>
        <div><div class="k">Canisters</div><div class="v">{fmtNum(s.canisters)}</div></div>
        <div><div class="k">Cycle burn</div><div class="v">{s.burn_per_day != null ? `${fmtCycles(s.burn_per_day)} / day` : "n/a"}</div></div>
        <div><div class="k">Block rate</div><div class="v">{s.block_rate != null ? `${s.block_rate.toFixed(2)} / s` : "n/a"}</div></div>
        <div><div class="k">Messages</div><div class="v">{s.msg_rate != null ? `${fmtNum(s.msg_rate, 1)} / s` : "n/a"}</div></div>
        <div><div class="k">State size</div><div class="v">{fmtBytes(s.memory_bytes)}</div></div>
        <div><div class="k">Replica version</div><div class="v mono">{s.replica_version ? s.replica_version.slice(0, 12) : "n/a"}</div></div>
      </div>

      <NetworkCharts group="sub" subnet={s.id} charts={[["burn", "Cycles burned per day", "this subnet"], ["blocks", "Block rate", "blocks per second"], ["messages", "Messages executed", "per second"], ["canisters", "Canisters", "running plus stopped"]]} />

      <div class="sec-head"><h2>Top canisters by measured burn</h2></div>
      <p class="note" style="margin:-6px 0 12px">
        Cycle balances are private on the IC, so no one can rank every canister on a subnet by burn. This list covers the canisters Lifeline can measure on this subnet, ranked by our own observed burn.
      </p>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Canister</th><th class="r">Burn / day</th><th class="r">Cycles</th></tr></thead>
          <tbody>
            {watched.map((c) => (
              <tr>
                <td><a href={`/canister/${c.id}`} class="name"><span><span class="t">{c.label}</span><span class="cid">{c.id}</span></span></a></td>
                <td class="r num strong">{c.burn_per_day != null ? fmtCycles(c.burn_per_day) : "n/a"}</td>
                <td class="r num">{c.cycles != null ? fmtCycles(c.cycles) : "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {watched.length ? null : <Empty>No measured canisters on this subnet yet.</Empty>}
      </div>
    </div>
  );
}

export function ProposalsPage({ proposals, status }: { proposals: ProposalRow[]; status: string }) {
  const tabs: [string, string][] = [["", "All"], ["open", "Open"], ["executed", "Executed"], ["rejected", "Rejected"]];
  return (
    <div class="wrap page" style="max-width:900px">
      <Crumbs items={[["Network", "/network"], ["Proposals", null]]} />
      <div class="page-head">
        <div><h1>NNS proposals</h1><p class="lede">Governance in plain language: what is being voted on, where the vote stands, and how it ended.</p></div>
        <Fresh ts={proposals[0]?.updated_at} source="NNS governance canister" staleAfter={5400} />
      </div>
      <div class="filters" style="margin-bottom:14px">
        {tabs.map(([v, l]) => <a class={`fpill${status === v ? " on" : ""}`} href={v ? `/network/proposals?status=${v}` : "/network/proposals"}>{l}</a>)}
      </div>
      {proposals.length ? <div class="stack">{proposals.map((p) => <ProposalItem p={p} />)}</div> : <div class="card"><Empty>No proposals in this view yet.</Empty></div>}
    </div>
  );
}

export function ProposalPage({ p, summaryHtml }: { p: ProposalRow; summaryHtml: string }) {
  const y = yesShare(p);
  const turnout = p.total && p.yes != null && p.no != null ? (p.yes + p.no) / p.total : null;
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Network", "/network"], ["Proposals", "/network/proposals"], [`#${p.id}`, null]]} />
      <div class="detail-head" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <span class={`prop`} style="padding:0"><span class={`topic ${topicClass(p.topic)}`}>{topicLabel(p.topic)}</span></span>
          <h1 style="margin-top:10px">{p.title || `Proposal ${p.id}`}</h1>
          <p class="muted" style="margin-top:6px">#{p.id} &middot; {statusLabel(p)} &middot; proposed {shortDate(p.created_at)}</p>
        </div>
      </div>
      <div class="card card-pad">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:8px">
          <span class="up">Yes {y == null ? "n/a" : `${(y * 100).toFixed(1)}%`}</span>
          <span class="muted">{turnout != null ? `${(turnout * 100).toFixed(1)}% of voting power has voted` : ""}</span>
          <span class="down">No {y == null ? "n/a" : `${((1 - y) * 100).toFixed(1)}%`}</span>
        </div>
        <div class="bar split" style="height:8px"><b class="y" style={`width:${(y ?? 0) * 100}%`}></b><b class="n" style={`width:${y == null ? 0 : (1 - y) * 100}%`}></b></div>
        <div style="margin-top:10px"><Fresh ts={p.updated_at} source="NNS governance canister, list_proposals" staleAfter={5400} label="tally read" /></div>
      </div>
      <div class="card kv" style="margin-top:14px">
        <div><div class="k">Action</div><div class="v">{p.action ?? "n/a"}</div></div>
        <div><div class="k">Proposer neuron</div><div class="v mono">{p.proposer ?? "n/a"}</div></div>
        <div><div class="k">Created</div><div class="v"><time datetime={isoDate(p.created_at)}>{shortDate(p.created_at)}</time></div></div>
        <div><div class="k">{p.decided_at ? "Decided" : "Voting ends"}</div><div class="v">{p.decided_at ? shortDate(p.decided_at) : p.deadline_at ? `${shortDate(p.deadline_at)} (${p.deadline_at > now() ? `in ${span(p.deadline_at - now())}` : ago(p.deadline_at)})` : "n/a"}</div></div>
      </div>
      <div class="sec-head"><h2>Summary</h2>{p.url ? <a class="link" style="font-size:12px" href={p.url} rel="noopener nofollow ugc">Discussion link</a> : null}</div>
      <div class="card card-pad prose" dangerouslySetInnerHTML={{ __html: summaryHtml || "<p>No summary was provided with this proposal.</p>" }}></div>
      <p class="note" style="margin-top:12px">
        Official view: <a class="link" rel="noopener" href={`https://dashboard.internetcomputer.org/proposal/${p.id}`}>dashboard.internetcomputer.org/proposal/{p.id}</a>
      </p>
    </div>
  );
}
