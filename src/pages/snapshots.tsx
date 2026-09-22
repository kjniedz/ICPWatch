// Holder snapshot tool: request form per token, and the permanent page for a taken snapshot.
import type { TokenRow } from "../db/queries";
import type { IndexProgress } from "../indexer/queries";
import { CATEGORIES, CATEGORY_TEXT } from "../labels";
import { fmtCompact, fmtNum, shortDate } from "../lib/format";
import type { SnapshotMeta, SnapshotRow } from "../snapshots";
import { Crumbs, Empty, Fresh } from "../ui/components";

const EXCLUDE_DEFAULT = new Set(["sns_treasury", "sns_governance", "sns_swap", "dex_pool", "dex", "minter", "burn"]);

export function SnapshotFormPage({ t, progress, previous, result, isSns }: { t: TokenRow; progress: IndexProgress | null; previous: SnapshotMeta[]; result?: { ok: boolean; message: string } | null; isSns: boolean }) {
  const ready = !!progress?.trusted;
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Markets", "/markets"], [`${t.name} (${t.symbol})`, `/token/${t.id}`], ["Snapshot", null]]} />
      <div class="page-head">
        <div>
          <h1>{t.symbol} holder snapshot</h1>
          <p class="lede">A frozen copy of every {t.symbol} balance at one block, from ICPWatch's own reconciled index, with a SHA-256 you can verify. Use it for airdrops, governance weights, or proof of a distribution at a point in time.</p>
        </div>
      </div>
      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}
      {!ready ? (
        <div class="card"><Empty>{progress ? `The ${t.symbol} index is ${progress.complete ? "complete but not yet reconciled against total supply" : `${progress.percent}% replayed`}. Snapshots are certified only from a complete, reconciled index.` : `ICPWatch has not started indexing ${t.symbol} yet.`}</Empty></div>
      ) : (
        <form class="card card-pad form" method="post" action={`/token/${t.id}/snapshot`}>
          <div class="callout" style="margin-bottom:14px"><Fresh ts={progress!.asOfTs} source={`block ${fmtNum(progress!.nextBlock - 1)}, ${fmtNum(progress!.holders)} holders, reconciled against icrc1_total_supply`} staleAfter={3600} label="index as of" /></div>
          <div class="grid-2" style="gap:12px">
            <label class="sub"><span>Minimum balance ({t.symbol})</span><input type="text" inputmode="decimal" name="min_balance" placeholder="0" /></label>
            <label class="sub"><span>Keep only the top N (optional)</span><input type="text" inputmode="numeric" name="top" placeholder="all" /></label>
          </div>
          <div class="field" style="margin-top:12px">
            <label>Exclude labeled entities</label>
            <div class="checks" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
              {CATEGORIES.map((c) => <label class="check"><input type="checkbox" name="exclude" value={c} checked={EXCLUDE_DEFAULT.has(c)} /><span><b>{CATEGORY_TEXT[c]}</b></span></label>)}
            </div>
            <div class="hint">Matched on the account and on its owner principal, using ICPWatch's <a class="link" href="/labels">entity labels</a>. Protocol-held balances are excluded by default.</div>
          </div>
          {isSns ? (
            <div class="field">
              <label class="check"><input type="checkbox" name="look_through" value="1" checked /><span><b>Attribute neuron stakes to their controllers</b>Governance canister subaccounts are folded away and each controller's staked {t.symbol} is added to its principal. Off means raw ledger accounts.</span></label>
            </div>
          ) : null}
          <div class="field"><label for="note">Note (optional, shown on the snapshot page)</label><input id="note" name="note" type="text" maxlength={200} placeholder="Round 2 airdrop eligibility" /></div>
          <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
          <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit">Take snapshot</button>
            <span class="note">Costs nothing. Two requests at the same block with the same filters return the same snapshot.</span>
          </div>
        </form>
      )}

      <div class="sec-head"><h2>Previous snapshots</h2></div>
      {previous.length ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Taken</th><th class="r">Block</th><th class="r">Rows</th><th class="hide-m">Filters</th><th class="hide-m">Hash</th><th></th></tr></thead>
            <tbody>{previous.map((s) => <SnapshotRowLine s={s} />)}</tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>No snapshot of {t.symbol} has been taken yet.</Empty></div>}
    </div>
  );
}

function filterText(s: SnapshotMeta): string {
  let f: { min_balance?: number; exclude?: string[]; top?: number | null } = {};
  try { f = JSON.parse(s.filters) as typeof f; } catch { /* none */ }
  const parts: string[] = [];
  if (f.min_balance) parts.push(`min ${fmtCompact(f.min_balance)}`);
  if (f.top) parts.push(`top ${fmtNum(f.top)}`);
  if (f.exclude?.length) parts.push(`${f.exclude.length} categories excluded`);
  if (s.look_through) parts.push("stakes attributed");
  return parts.join(", ") || "none";
}

function SnapshotRowLine({ s, withToken }: { s: SnapshotMeta; withToken?: boolean }) {
  return (
    <tr>
      <td>{withToken ? <><a class="link" href={`/token/${s.ledger}`}>{s.symbol}</a> · </> : null}{shortDate(s.taken_at)}</td>
      <td class="r num">{fmtNum(s.block)}</td>
      <td class="r num">{fmtNum(s.rows)}</td>
      <td class="hide-m muted" style="font-size:12px">{filterText(s)}</td>
      <td class="hide-m mono" style="font-size:11px">{s.hash.slice(0, 16)}…</td>
      <td class="r"><a class="link" href={`/snapshot/${s.id}`}>Open</a></td>
    </tr>
  );
}

export function SnapshotPage({ s, rows, url }: { s: SnapshotMeta; rows: SnapshotRow[]; url: string }) {
  const scale = 10 ** s.decimals;
  const supply = s.supply_raw ? Number(BigInt(s.supply_raw)) / scale : null;
  const sum = Number(BigInt(s.sum_raw)) / scale;
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Markets", "/markets"], [s.symbol, `/token/${s.ledger}`], ["Snapshot", `/token/${s.ledger}/snapshot`], [s.id, null]]} />
      <div class="page-head">
        <div>
          <h1>{s.symbol} holders at block {fmtNum(s.block)}</h1>
          <p class="lede">{s.creator_note ? <>{s.creator_note}. </> : null}Taken {shortDate(s.taken_at)} from ICPWatch's reconciled index. This page and its files never change.</p>
        </div>
        <div class="page-actions">
          <a class="btn btn-primary" href={`/snapshot/${s.id}.csv`} download>CSV</a>
          <a class="btn btn-ghost" href={`/snapshot/${s.id}.json`}>JSON</a>
        </div>
      </div>
      <div class="card statbar">
        <div><div class="v">{fmtNum(s.rows)}</div><div class="k">Rows{s.rows !== s.holders_total ? ` of ${fmtNum(s.holders_total)} holders` : ""}</div></div>
        <div><div class="v">{fmtCompact(sum)}</div><div class="k">{s.symbol} in the file{supply ? ` (${((sum / supply) * 100).toFixed(1)}% of supply)` : ""}</div></div>
        <div><div class="v">{s.block_ts ? shortDate(s.block_ts) : "n/a"}</div><div class="k">Block time</div></div>
        <div><div class="v">{fmtCompact(s.size_bytes)}B</div><div class="k">Canonical CSV</div></div>
      </div>
      <div class="card card-pad" style="margin-top:14px">
        <div class="k" style="font-size:12px;color:var(--text-2)">SHA-256 of the CSV</div>
        <div class="mono" style="font-size:12.5px;word-break:break-all;margin:4px 0 8px">{s.hash}</div>
        <div class="src">Verify: <code>curl -s {url}/snapshot/{s.id}.csv | shasum -a 256</code>. Filters: {filterText(s)}. Ledger <span class="mono">{s.ledger}</span>{s.supply_raw ? `, total supply ${fmtCompact(supply)} ${s.symbol} at the time` : ""}.</div>
      </div>

      <div class="sec-head"><h2>Rows</h2><span class="note">first {fmtNum(Math.min(rows.length, 200))}{rows.length > 200 ? `, the file has all ${fmtNum(s.rows)}` : ""}</span></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>#</th><th>Account</th><th class="r">Balance</th><th class="r hide-m">Share</th></tr></thead>
          <tbody>
            {rows.slice(0, 200).map((r) => (
              <tr>
                <td class="muted">{r.rank}</td>
                <td class="mono" style="font-size:12px"><a href={`/account/${r.owner}`}>{r.account}</a></td>
                <td class="r num">{fmtCompact(r.balance)}</td>
                <td class="r num hide-m">{supply ? `${((r.balance / supply) * 100).toFixed(3)}%` : "n/a"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SnapshotsIndexPage({ items }: { items: SnapshotMeta[] }) {
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Markets", "/markets"], ["Snapshots", null]]} />
      <div class="page-head"><div><h1>Holder snapshots</h1><p class="lede">Frozen, hashed holder lists taken from ICPWatch's reconciled ledger index. Open any token page and choose Snapshot to take one.</p></div></div>
      {items.length ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Token, taken</th><th class="r">Block</th><th class="r">Rows</th><th class="hide-m">Filters</th><th class="hide-m">Hash</th><th></th></tr></thead>
            <tbody>{items.map((s) => <SnapshotRowLine s={s} withToken />)}</tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>No snapshots yet.</Empty></div>}
    </div>
  );
}
