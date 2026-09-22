// /markets/launchpad: what is being launched right now, with the flags a buyer should see first.
import type { LaunchRow } from "../launchpad";
import { ago, fmtCompact, fmtNum } from "../lib/format";
import { Crumbs, Empty, Fresh } from "../ui/components";

const FLAG_TEXT: Record<string, string> = { bundled: "Top 5 hold most of it", creator_sold: "Creator sold down", frozen: "Frozen by the launchpad", thin: "Very thin liquidity", creator_heavy: "Creator holds a lot" };
const sats = (v: number | null | undefined) => (v == null ? "n/a" : v >= 1e8 ? `${(v / 1e8).toFixed(3)} BTC` : `${fmtCompact(v)} sats`);

function Row({ r, state }: { r: LaunchRow; state: string }) {
  let flags: string[] = [];
  try { flags = JSON.parse(r.flags) as string[]; } catch { flags = []; }
  let links: { website?: string | null; twitter?: string | null; telegram?: string | null } = {};
  try { links = r.links ? (JSON.parse(r.links) as typeof links) : {}; } catch { links = {}; }
  const gradeCls = r.grade === "B" ? "up" : r.grade === "E" ? "down" : "";
  return (
    <tr class={r.frozen ? "dead" : undefined} data-state={state} data-search={`${r.ticker} ${r.name} ${r.creator ?? ""}`}>
      <td>
        <div style="display:flex;gap:8px;align-items:center">
          {r.logo ? <img src={r.logo} alt="" width="22" height="22" style="border-radius:50%;object-fit:cover" loading="lazy" /> : <span class="logo-fallback">{r.ticker.slice(0, 2)}</span>}
          <span><b>{r.ticker}</b> <span class="muted">{r.name}</span><span class="cid">{r.kind ?? ""}{r.created_at ? ` · ${ago(r.created_at)}` : ""}</span></span>
        </div>
      </td>
      <td>
        <span class="liq" title={`${Math.round((r.progress ?? 0) * 100)}% of the bonding curve`}><i><b style={`width:${Math.round((r.progress ?? 0) * 100)}%`}></b></i>{r.graduated ? "graduated" : `${Math.round((r.progress ?? 0) * 100)}%`}</span>
      </td>
      <td class="r num hide-m">{sats(r.mcap_sats)}</td>
      <td class="r num hide-m">{sats(r.pool_sats)}</td>
      <td class="r num hide-m">{r.creator_share != null ? `${(r.creator_share * 100).toFixed(0)}% / ${r.top5_share != null ? `${(r.top5_share * 100).toFixed(0)}%` : "n/a"}` : <span class="muted" title="Under 5% of supply has been bought, so holder shares are not meaningful yet">too early</span>}</td>
      <td><span class={`num ${gradeCls}`} title="Provisional: age, creator and top-5 share, LP lock, graduation, freeze. Not the full ICPWatch trust score.">{r.grade ?? "?"} · {r.score ?? "?"}</span> <span class="chip">provisional</span></td>
      <td>{flags.length ? flags.map((f) => <span class={`chip ${f === "frozen" || f === "creator_sold" ? "chip-dead" : "chip-warn"}`} title={FLAG_TEXT[f] ?? f}>{f.replace(/_/g, " ")}</span>) : <span class="muted">none</span>}</td>
      <td class="hide-m">
        {links.website ? <a class="link" href={links.website} rel="noopener nofollow">web</a> : null}{" "}
        {links.twitter ? <a class="link" href={links.twitter} rel="noopener nofollow">x</a> : null}{" "}
        {links.telegram ? <a class="link" href={links.telegram} rel="noopener nofollow">tg</a> : null}
      </td>
    </tr>
  );
}

export function LaunchpadPage({ rows, fetchedAt }: { rows: LaunchRow[]; fetchedAt: number | null }) {
  const live = rows.filter((r) => !r.graduated && !r.frozen);
  const soon = live.filter((r) => (r.progress ?? 0) >= 0.7);
  const graduated = rows.filter((r) => r.graduated);
  const flagged = rows.filter((r) => r.flags !== "[]").length;
  return (
    <div class="wrap page" style="max-width:1200px">
      <Crumbs items={[["Markets", "/markets"], ["Launchpad", null]]} />
      <div class="page-head">
        <div>
          <h1>Launchpad feed</h1>
          <p class="lede">
            Every token launching on FomoWell, the one launchpad on the Internet Computer with a live, publicly readable canister. Tokens here are bonding-curve memecoins quoted in sats; most will never graduate. The grade is provisional and exists to surface bundled buys, creators selling down, and thin pools before you click through.
          </p>
        </div>
        <div class="page-actions"><Fresh ts={fetchedAt} source="FomoWell canister arcoq-syaaa-aaaah-arewa-cai, read directly" staleAfter={7200} label="read" /></div>
      </div>
      <div class="card statbar">
        <div><div class="v">{fmtNum(live.length)}</div><div class="k">On the curve</div></div>
        <div><div class="v c-amber">{fmtNum(soon.length)}</div><div class="k">Past 70%, graduating soon</div></div>
        <div><div class="v c-green">{fmtNum(graduated.length)}</div><div class="k">Graduated to a pool</div></div>
        <div><div class="v c-red">{fmtNum(flagged)}</div><div class="k">Carry a flag</div></div>
      </div>
      <div class="sec-head" style="margin-top:16px">
        <h2>Latest launches <span class="muted" style="font-weight:500;font-size:12px">&nbsp;<span data-count-for="lp">{rows.length}</span> shown</span></h2>
        <div class="filters">
          <input class="input" type="search" placeholder="Filter" data-filter-for="lp" aria-label="Filter launches" />
          <button class="fpill" data-for="lp" data-fkey="state" data-fval="all" aria-pressed="true">All</button>
          <button class="fpill" data-for="lp" data-fkey="state" data-fval="live" aria-pressed="false">On the curve</button>
          <button class="fpill" data-for="lp" data-fkey="state" data-fval="soon" aria-pressed="false">Graduating soon</button>
          <button class="fpill" data-for="lp" data-fkey="state" data-fval="graduated" aria-pressed="false">Graduated</button>
          <button class="fpill" data-for="lp" data-fkey="state" data-fval="flagged" aria-pressed="false">Flagged</button>
        </div>
      </div>
      {rows.length ? (
        <div class="card tbl-wrap">
          <table class="tbl" id="lp" data-sortable>
            <thead><tr><th data-sort="text">Token</th><th>Curve</th><th class="r hide-m" data-sort="num">Market cap</th><th class="r hide-m" data-sort="num">Pool</th><th class="r hide-m" title="Creator share / top 5 share of circulating supply">Creator / top 5</th><th data-sort="num">Grade</th><th>Flags</th><th class="hide-m">Links</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const state = [r.graduated ? "graduated" : r.frozen ? "frozen" : "live", !r.graduated && !r.frozen && (r.progress ?? 0) >= 0.7 ? "soon" : "", r.flags !== "[]" ? "flagged" : ""].filter(Boolean).join(" ");
                return <Row r={r} state={state} />;
              })}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>The launchpad collector has not run yet.</Empty></div>}
      <div class="src" style="margin-top:10px">
        Creator and top-5 shares exclude the bonding-curve pool account and are measured against circulating supply. "Creator sold" fires when the creator's share halves from what we first saw. LP lock is read from the launchpad's lock registry. Prices are in sats because that is what the curve is quoted in; nothing here is priced in USD until a token has an ICRC ledger and a DEX pool we track.
      </div>
    </div>
  );
}
