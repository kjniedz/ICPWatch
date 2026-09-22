import type { NftRow } from "../nfts";
import { REGISTRY_SOURCE } from "../nfts";
import { fmtCompact, fmtNum } from "../lib/format";
import { Crumbs, Empty, Fresh, HealthPill } from "../ui/components";

export function NftsPage({ rows, icpUsd }: { rows: NftRow[]; icpUsd: number | null }) {
  const usd = (icp: number | null) => (icp != null && icpUsd != null ? ` (${fmtCompact(icp * icpUsd, "$")})` : "");
  const total = rows.reduce((s, r) => s + (r.volume_icp ?? 0), 0);
  const listed = rows.reduce((s, r) => s + (r.listings ?? 0), 0);
  return (
    <div class="wrap page" style="max-width:1200px">
      <Crumbs items={[["Markets", "/markets"], ["NFTs", null]]} />
      <div class="page-head">
        <div>
          <h1>NFT collections</h1>
          <p class="lede">EXT collections on the Internet Computer. Names and links come from a third-party registry; every number is read from the collection canister itself with its <code>stats()</code> query: lifetime volume, floor, listings, supply, trades. Each collection is a canister, so Lifeline can watch its cycles too.</p>
        </div>
        <div class="page-actions"><Fresh ts={rows[0]?.stats_at ?? null} source={`collection canisters (stats query) + ${REGISTRY_SOURCE}`} staleAfter={3 * 86400} label="read" /></div>
      </div>
      <div class="card statbar">
        <div><div class="v">{fmtNum(rows.length)}</div><div class="k">Collections answering</div></div>
        <div><div class="v">{fmtCompact(total)} ICP</div><div class="k">Lifetime volume{usd(total)}</div></div>
        <div><div class="v">{fmtNum(listed)}</div><div class="k">Listed right now</div></div>
      </div>
      <div class="sec-head" style="margin-top:16px"><h2>By lifetime volume <span class="muted" style="font-weight:500;font-size:12px">&nbsp;<span data-count-for="nfts">{rows.length}</span> shown</span></h2><div class="filters"><input class="input" type="search" placeholder="Filter collections" data-filter-for="nfts" aria-label="Filter" /></div></div>
      {rows.length ? (
        <div class="card tbl-wrap">
          <table class="tbl" id="nfts" data-sortable>
            <thead><tr><th data-sort="text">Collection</th><th class="r" data-sort="num" aria-sort="descending">Volume</th><th class="r" data-sort="num">Floor</th><th class="r hide-m" data-sort="num">Listed</th><th class="r hide-m" data-sort="num">Supply</th><th class="r hide-m" data-sort="num">Trades</th><th class="hide-m">Links</th><th data-sort="text">Canister</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                let l: { web?: string | null; twitter?: string | null; discord?: string | null } = {};
                try { l = r.links ? (JSON.parse(r.links) as typeof l) : {}; } catch { l = {}; }
                return (
                  <tr data-search={`${r.name} ${r.id}`}>
                    <td data-v={r.name.toLowerCase()}><div style="display:flex;gap:8px;align-items:center">{r.avatar ? <img src={r.avatar} alt="" width="24" height="24" style="border-radius:6px;object-fit:cover" loading="lazy" /> : null}<span><b>{r.name}</b><span class="cid">{r.standard ?? "ext"} · {r.id}</span></span></div></td>
                    <td class="r num strong" data-v={r.volume_icp ?? 0}>{fmtCompact(r.volume_icp)} ICP<span class="cid">{usd(r.volume_icp).replace(/[()]/g, "")}</span></td>
                    <td class="r num" data-v={r.floor_icp ?? 0}>{r.floor_icp ? `${fmtCompact(r.floor_icp)} ICP` : <span class="muted">none</span>}</td>
                    <td class="r num hide-m" data-v={r.listings ?? 0}>{fmtNum(r.listings)}</td>
                    <td class="r num hide-m" data-v={r.supply ?? 0}>{fmtNum(r.supply)}</td>
                    <td class="r num hide-m" data-v={r.trades ?? 0}>{fmtNum(r.trades)}</td>
                    <td class="hide-m">{l.web ? <a class="link" href={l.web} rel="noopener nofollow">web</a> : null} {l.twitter ? <a class="link" href={l.twitter} rel="noopener nofollow">x</a> : null} {l.discord ? <a class="link" href={l.discord} rel="noopener nofollow">discord</a> : null}</td>
                    <td data-v={r.health ?? "z"}><a href={`/canister/${r.id}`}>{r.health ? <HealthPill health={r.health} label={r.health} /> : <span class="link">watch cycles</span>}</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>The nightly NFT read has not run yet.</Empty></div>}
      <div class="src" style="margin-top:10px">Volume is what each canister reports since its own launch, in ICP; USD uses today's ICP price, not the price at each sale. Collections whose canister does not answer stats() are left out rather than shown with someone else's numbers.</div>
    </div>
  );
}
