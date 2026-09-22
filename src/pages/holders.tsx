// /token/:id/holders: the full holder picture from our own index. Every chart is server-rendered SVG,
// so the page needs no client code beyond the shared islands.
import type { TokenRow } from "../db/queries";
import type { Bucket, Concentration, DailyRow, EntitySlice, HoldersPage as HoldersData } from "../holders";
import { CATEGORY_TEXT } from "../labels";
import { fmtCompact, fmtNum, shortDate, ago } from "../lib/format";
import { Crumbs, Empty, Fresh } from "../ui/components";
import { EntityName } from "./labels";

const PALETTE = ["#2ba5e2", "#6d4fe0", "#35c985", "#f7931e", "#ff6b57", "#e0c14f", "#4bb6ea", "#9b7cf0", "#5fd9a3", "#f9b062", "#ff8f80", "#8aa0b6"];
const pct = (v: number | null | undefined, d = 1) => (v == null ? "n/a" : `${(v * 100).toFixed(d)}%`);

/** Donut from shares that sum to at most 1. Anything left over is drawn as "everyone else". */
function Donut({ slices, size = 168 }: { slices: { name: string; share: number; href?: string | null }[]; size?: number }) {
  const r = 40, c = 2 * Math.PI * r;
  let acc = 0;
  const total = slices.reduce((s, x) => s + x.share, 0);
  const rest = Math.max(0, 1 - total);
  const all = rest > 0.0005 ? [...slices, { name: "Everyone else", share: rest, href: null }] : slices;
  return (
    <div class="donut">
      <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Share of supply">
        {all.map((s, i) => {
          const dash = Math.max(0, s.share) * c;
          const el = <circle r={r} cx="50" cy="50" fill="none" stroke={i === all.length - 1 && rest > 0.0005 ? "var(--border)" : PALETTE[i % PALETTE.length]} stroke-width="14" stroke-dasharray={`${dash} ${c - dash}`} stroke-dashoffset={-acc * c + c / 4}><title>{s.name}: {pct(s.share)}</title></circle>;
          acc += s.share;
          return el;
        })}
      </svg>
      <ul class="legend">
        {all.map((s, i) => (
          <li>
            <i style={`background:${i === all.length - 1 && rest > 0.0005 ? "var(--border)" : PALETTE[i % PALETTE.length]}`}></i>
            {s.href ? <a href={s.href} class="link">{s.name}</a> : <span>{s.name}</span>}
            <b>{pct(s.share)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Holder count over time with new (up) and exited (down) bars beneath. */
function History({ rows }: { rows: DailyRow[] }) {
  if (rows.length < 2) return <Empty>Daily snapshots start once a ledger's index is trusted. Check back tomorrow.</Empty>;
  const w = 640, h = 140, pad = 4;
  const xs = rows.map((_, i) => pad + (i / (rows.length - 1)) * (w - 2 * pad));
  const min = Math.min(...rows.map((r) => r.holders)), max = Math.max(...rows.map((r) => r.holders));
  const y = (v: number) => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - 2 * pad - 30));
  const path = rows.map((r, i) => `${i ? "L" : "M"}${xs[i]!.toFixed(1)} ${y(r.holders).toFixed(1)}`).join(" ");
  const flowMax = Math.max(1, ...rows.map((r) => Math.max(r.new_holders, r.exited)));
  const bw = Math.max(1, (w - 2 * pad) / rows.length - 1);
  const first = rows[0]!, last = rows[rows.length - 1]!;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Holders over time">
        <path d={path} fill="none" stroke="var(--blue)" stroke-width="2" vector-effect="non-scaling-stroke" />
        {rows.map((r, i) => (
          <>
            <rect x={xs[i]! - bw / 2} y={h - 26 - (r.new_holders / flowMax) * 12} width={bw} height={(r.new_holders / flowMax) * 12} fill="var(--up)" opacity="0.8"><title>{shortDate(r.day)}: {r.new_holders} new</title></rect>
            <rect x={xs[i]! - bw / 2} y={h - 26} width={bw} height={(r.exited / flowMax) * 12} fill="var(--down)" opacity="0.8"><title>{shortDate(r.day)}: {r.exited} exited</title></rect>
          </>
        ))}
      </svg>
      <div class="src" style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <span>{shortDate(first.day)}: {fmtNum(first.holders)} holders</span>
        <span><i class="sw" style="background:var(--up)"></i> new <i class="sw" style="background:var(--down)"></i> exited, per day</span>
        <span>{shortDate(last.day)}: {fmtNum(last.holders)} holders</span>
      </div>
    </div>
  );
}

export function HoldersPage({ t, data, conc, buckets, mix, history }: {
  t: TokenRow; data: HoldersData; conc: Concentration; buckets: Bucket[]; mix: EntitySlice[]; history: DailyRow[];
}) {
  const p = data.progress;
  const link = (page: number, stake = data.lookThrough) => `/token/${t.id}/holders?page=${page}${stake ? "" : "&stake=0"}${data.query ? `&q=${encodeURIComponent(data.query)}` : ""}`;
  const top10 = data.rows.slice(0, 10);
  const stakedShare = data.sns && data.supplyUnits ? data.sns.staked / data.supplyUnits : null;
  const totalBuckets = buckets.reduce((s, b) => s + b.holders, 0) || 1;
  const catName = (c: string) => (c === "unlabeled" ? "Unlabeled accounts" : c === "neuron_holder" ? "Neuron stakers" : c === "everyone_else" ? "Everyone else" : (CATEGORY_TEXT as Record<string, string>)[c] ?? c);
  return (
    <div class="wrap page" style="max-width:1200px">
      <Crumbs items={[["Markets", "/markets"], [`${t.name} (${t.symbol})`, `/token/${t.id}`], ["Holders", null]]} />
      <div class="page-head">
        <div>
          <h1>{t.symbol} holders</h1>
          <p class="lede">
            Every balance on the {t.name} ledger, replayed block by block into ICPWatch's own index and reconciled exactly against <code>icrc1_total_supply</code>. Nothing here comes from a third party.
          </p>
        </div>
        <div class="page-actions">
          <a class="btn btn-ghost" href={`/token/${t.id}/holders.csv${data.lookThrough ? "" : "?stake=0"}`} download>CSV (top {fmtNum(5000)})</a>
          <a class="btn btn-ghost" href={`/api/v1/token/${t.id}/holders${data.lookThrough ? "" : "?stake=0"}`}>JSON</a>
          <a class="btn btn-ghost" href={`/token/${t.id}/snapshot`} title="A frozen, hashed copy at one block">Snapshot</a>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;margin:-6px 0 12px">
        <Fresh ts={p.asOfTs} source={`ICPWatch block index, block ${fmtNum(p.nextBlock - 1)}, reconciled ${p.reconciledAt ? ago(p.reconciledAt) : "n/a"}`} staleAfter={3600} label="as of block time" />
      </div>

      <div class="card statbar">
        <div><div class="v">{fmtNum(conc.holders)}</div><div class="k">Holders with a balance</div></div>
        <div><div class="v">{pct(conc.top10Share)}</div><div class="k">Held by the top 10</div></div>
        <div><div class="v">{conc.gini != null ? conc.gini.toFixed(3) : "n/a"}</div><div class="k" title="0 is perfectly equal, 1 is one account holding everything">Gini coefficient</div></div>
        <div><div class="v">{conc.nakamoto != null ? `${conc.nakamoto >= 1000 ? "1000+" : conc.nakamoto}` : "n/a"}</div><div class="k" title="Fewest accounts that together hold more than half of supply">Nakamoto coefficient</div></div>
        {data.sns ? <div><div class="v c-purple">{pct(stakedShare)}</div><div class="k">Staked in {fmtNum(data.sns.neurons)} neurons</div></div> : null}
        <div><div class="v">{fmtNum(p.accounts)}</div><div class="k">Accounts ever seen</div></div>
      </div>

      {data.sns ? (
        <div class="callout" style="margin-top:14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <span>
            <b>SNS look-through {data.lookThrough ? "on" : "off"}.</b>{" "}
            {data.lookThrough
              ? `Neuron stakes are attributed to the principal that controls each neuron, and the governance canister's ${fmtNum(data.sns.neurons)} stake accounts are folded away. Ranking is liquid plus staked.`
              : "Balances are shown exactly as the ledger holds them: neuron stakes sit in governance canister subaccounts and rank as such."}
            {data.sns.walkDone == null ? " Our neuron walk has not finished its first pass yet, so staked figures are partial." : ""}
          </span>
          <a class="btn btn-ghost" style="margin-left:auto" href={link(1, !data.lookThrough)}>{data.lookThrough ? "Show raw ledger accounts" : "Attribute stakes to controllers"}</a>
        </div>
      ) : null}

      <div class="grid-3" style="margin-top:16px">
        <div class="card card-pad">
          <div class="sec-head" style="margin-top:0"><h2>Top 10 and the rest</h2></div>
          <Donut slices={top10.map((h) => ({ name: h.label?.name ?? `${h.account.slice(0, 5)}…${h.account.slice(-3)}`, share: h.share ?? 0, href: `/account/${h.owner}` }))} />
        </div>
        <div class="card card-pad">
          <div class="sec-head" style="margin-top:0"><h2>By entity type</h2></div>
          {mix.length ? <Donut slices={mix.filter((m) => m.category !== "everyone_else").map((m) => ({ name: catName(m.category), share: m.share }))} /> : <Empty>No supply figure to compute shares.</Empty>}
          <div class="src" style="margin-top:8px">Over the largest {fmtNum(data.rows.length)} accounts on this page, by <a class="link" href="/labels">entity label</a>.</div>
        </div>
        <div class="card card-pad">
          <div class="sec-head" style="margin-top:0"><h2>Balance bands</h2></div>
          <table class="tbl mini">
            <tbody>
              {buckets.map((b) => (
                <tr>
                  <td>{b.label} {t.symbol}</td>
                  <td class="r num">{fmtNum(b.holders)}</td>
                  <td style="width:38%"><i class="bar"><b style={`width:${Math.max(1, Math.round((b.holders / totalBuckets) * 100))}%`}></b></i></td>
                  <td class="r num muted">{fmtCompact(b.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="sec-head"><h2>Holders over time</h2></div>
      <div class="card card-pad"><History rows={history} /></div>

      <div class="sec-head">
        <h2>All holders <span class="muted" style="font-weight:500;font-size:12px">&nbsp;{fmtNum(data.total)} {data.query ? "matching" : data.lookThrough ? "ranked" : "total"}, page {data.page} of {fmtNum(data.pages)}</span></h2>
        <form method="get" action={`/token/${t.id}/holders`} class="filters">
          {data.lookThrough ? null : <input type="hidden" name="stake" value="0" />}
          <input class="input" type="search" name="q" value={data.query} placeholder="Find an account or principal" aria-label="Find an account" autocomplete="off" spellcheck={false} />
          <button class="btn btn-ghost" type="submit">Search</button>
        </form>
      </div>
      {data.rows.length ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th style="width:48px">#</th>
                <th>Account</th>
                <th class="r">Balance</th>
                {data.lookThrough ? <th class="r hide-m">Liquid</th> : null}
                {data.lookThrough ? <th class="r hide-m">Staked</th> : null}
                <th class="r">Share</th>
                <th class="r hide-m">Transfers</th>
                <th class="r hide-m">First seen</th>
                <th class="r hide-m">Last active</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((h) => (
                <tr>
                  <td class="muted">{h.rank}</td>
                  <td><EntityName id={h.account} label={h.label} /></td>
                  <td class="r num strong">{fmtCompact(h.balance)}</td>
                  {data.lookThrough ? <td class="r num hide-m">{h.liquid ? fmtCompact(h.liquid) : <span class="muted">0</span>}</td> : null}
                  {data.lookThrough ? <td class="r num hide-m">{h.staked ? <span title={`${h.neurons} neurons`}>{fmtCompact(h.staked)}</span> : <span class="muted">0</span>}</td> : null}
                  <td class="r num">{h.share != null ? `${(h.share * 100).toFixed(h.share < 0.001 ? 4 : 2)}%` : "n/a"}</td>
                  <td class="r num hide-m">{h.txCount != null ? fmtNum(h.txCount) : <span class="muted">n/a</span>}</td>
                  <td class="r hide-m">{h.firstSeen ? shortDate(h.firstSeen) : <span class="muted">n/a</span>}</td>
                  <td class="r hide-m">{h.lastActive ? ago(h.lastActive) : <span class="muted">n/a</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>No account on this ledger starts with "{data.query}".</Empty></div>}
      {data.pages > 1 ? (
        <nav class="pager" aria-label="Pages">
          {data.page > 1 ? <a class="btn btn-ghost" href={link(data.page - 1)}>&larr; Previous</a> : <span></span>}
          <span class="muted">Page {data.page} of {fmtNum(data.pages)}</span>
          {data.page < data.pages ? <a class="btn btn-ghost" href={link(data.page + 1)}>Next &rarr;</a> : <span></span>}
        </nav>
      ) : null}
      <div class="src" style="margin-top:10px">
        Balances are whole tokens from exact base units. Share uses the ledger's reported total supply. First seen and last active are block timestamps. Staked figures come from each SNS governance canister's <code>list_neurons</code>, walked in full every three days.
      </div>
    </div>
  );
}
