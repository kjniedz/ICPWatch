import type { CanisterRow } from "../db/queries";
import { ago, fmtCycles, isoDate, now, span } from "../lib/format";
import type { ReserveSnapshot } from "../reserves/collect";
import { unitsToNumber } from "../reserves/reconcile";
import { Crumbs, Empty, Fresh, HealthPill } from "../ui/components";
import { RangeTools } from "./detail";

export interface LatestRow { asset: string; symbol: string; chain: string; ledger_id: string; minter_id: string; ts: number; status: string; raw_ratio: number | null; reconciled_ratio: number | null; supply_raw: string | null; reserves_raw: string | null; native_raw: string | null; pending_in_raw: string | null; pending_out_raw: string | null; verified: number; data: string }

const STATUS: Record<string, [string, string]> = { backed: ["Fully backed", "ok"], within_tolerance: ["Within tolerance", "risk"], deviation: ["Deviation", "frozen"], unknown: ["Unknown", "unk"] };
const pct = (r: number | null | undefined) => (r == null ? "n/a" : `${(r * 100).toFixed(r >= 0.9995 && r < 1.9995 ? 3 : 2)}%`);
const units = (raw: string | null | undefined, decimals: number, max = 6) => {
  if (raw == null) return "n/a";
  const n = unitsToNumber(BigInt(raw), decimals);
  return n == null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: Math.min(max, decimals) });
};
export const parseSnap = (row: LatestRow): ReserveSnapshot | null => {
  try { return JSON.parse(row.data) as ReserveSnapshot; } catch { return null; }
};

export function ReservesPage({ rows, health }: { rows: LatestRow[]; health: Map<string, CanisterRow> }) {
  const bad = rows.filter((r) => r.status === "deviation");
  const unknown = rows.filter((r) => r.status === "unknown");
  const headline = !rows.length ? "Waiting for the first check" : bad.length ? `${bad.length} of ${rows.length} Chain Fusion assets show a backing deviation` : unknown.length ? `${rows.length - unknown.length} of ${rows.length} Chain Fusion assets verified backed, ${unknown.length} unreadable right now` : `All ${rows.length} Chain Fusion assets fully backed`;
  const latest = rows.reduce((m, r) => Math.max(m, r.ts), 0);
  return (
    <div class="wrap page" style="max-width:1100px">
      <Crumbs items={[["Markets", "/markets"], ["ck reserves", null]]} />
      <div class="page-head">
        <div>
          <h1>Chain Fusion reserves</h1>
          <p class="lede">Continuous proof of backing for every ck asset: what the minter holds on the native chain, what exists on the IC, and the difference explained line by line.</p>
        </div>
        <Fresh ts={latest || null} source="minters, ledgers, and two native-chain sources per asset" staleAfter={1500} label="checked" />
      </div>
      <div class={`card card-pad`} style={`border-left:4px solid var(--${bad.length ? "low" : unknown.length ? "risk" : "up"});margin-bottom:18px`}>
        <div style="font-size:19px;font-weight:700">{headline}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">Backed means net reserves (minter reserves minus withdrawals in flight) cover the supply on the IC. Verified means an independent native-chain source confirmed the minter's figure.</div>
      </div>
      <div class="card tbl-wrap">
        <table class="tbl" id="reserves" data-sortable>
          <thead><tr><th data-sort="text">Asset</th><th class="r" data-sort="num">Supply on IC</th><th class="r" data-sort="num">Native reserves</th><th class="r hide-m" data-sort="num">In flight out</th><th class="r" data-sort="num">Raw ratio</th><th class="r" data-sort="num">Reconciled</th><th data-sort="text">Status</th><th class="hide-m">Minter health</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const s = parseSnap(r);
              const d = s?.decimals ?? 8;
              const [label, cls] = STATUS[r.status] ?? STATUS.unknown!;
              const m = health.get(r.minter_id);
              return (
                <tr data-search={r.symbol}>
                  <td data-v={r.symbol}><a href={`/reserves/${r.asset}`} style="font-weight:600">{r.symbol}</a> <span class="muted" style="font-size:11px">{s?.nativeAsset ?? r.chain}</span></td>
                  <td class="r num" data-v={r.supply_raw ?? ""}>{units(r.supply_raw, d, 4)}</td>
                  <td class="r num" data-v={r.reserves_raw ?? ""}>{units(r.reserves_raw, d, 4)}{r.verified ? <span title="confirmed on the native chain" style="color:var(--up);margin-left:5px">&#10003;</span> : null}</td>
                  <td class="r num hide-m" data-v={r.pending_out_raw ?? ""}>{units(r.pending_out_raw, d, 4)}</td>
                  <td class="r num" data-v={r.raw_ratio ?? ""}>{pct(r.raw_ratio)}</td>
                  <td class="r num strong" data-v={r.reconciled_ratio ?? ""}>{pct(r.reconciled_ratio)}</td>
                  <td data-v={r.status}><span class={`pill ${cls}`}>{label}</span></td>
                  <td class="hide-m">{m ? <a href={`/canister/${m.id}`}><HealthPill health={m.health} /> <span class="muted nowrap" style="font-size:11px">{m.cycles != null ? fmtCycles(m.cycles) : ""}</span></a> : <span class="muted">not watched</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length ? null : <Empty>The reserves collector has not run yet.</Empty>}
      </div>
      <p class="note" style="margin-top:12px">
        Reserves come from each minter canister's own accounting (NNS-controlled canisters that hold the threshold keys), cross-checked against public Bitcoin explorers and Ethereum RPC nodes, which are third parties. ckBTC is spread over thousands of deposit addresses, so its native check covers a sample and says so. <a class="link" href="/data-sources">Data sources</a>
      </p>
    </div>
  );
}

export function ReserveAssetPage({ row, minter, ledger }: { row: LatestRow; minter: CanisterRow | null; ledger: CanisterRow | null }) {
  const s = parseSnap(row);
  if (!s) return <div class="wrap page narrow"><Empty>Snapshot unreadable.</Empty></div>;
  const d = s.decimals;
  const [label, cls] = STATUS[row.status] ?? STATUS.unknown!;
  const nowTs = now();
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Markets", "/markets"], ["ck reserves", "/reserves"], [s.symbol, null]]} />
      <div class="detail-head">
        <div><h1>{s.symbol} reserves <span class={`pill ${cls}`}>{label}</span></h1><div class="muted" style="font-size:13px;margin-top:4px">Backed by {s.nativeAsset} held by the minter on {s.chain === "bitcoin" ? "Bitcoin" : "Ethereum"}.</div></div>
        <div class="px"><div class="v">{pct(s.rec.reconciledRatio)}</div><div class="muted" style="font-size:12px">reconciled backing</div></div>
      </div>
      <div class="callout" style="margin-bottom:16px">{s.rec.explanation}</div>

      <div class="card kv">
        <div><div class="k">Supply on IC</div><div class="v">{units(s.supply.supply, d)}</div><div class="s">{s.supply.prov.source}</div></div>
        <div><div class="k">Minter reserves</div><div class="v">{units(s.minter.reserves, d)}</div><div class="s">first party: the minter's own accounting</div></div>
        <div><div class="k">Native chain</div><div class="v">{s.rec.nativeConsensus != null ? units(s.rec.nativeConsensus.toString(), d) : "n/a"}</div><div class="s">{s.rec.nativeAgreement === "agree" ? "two independent sources agree" : s.rec.nativeAgreement === "single" ? "one source answered" : s.rec.nativeAgreement === "differ" ? "sources disagree" : "unavailable"}{s.chain === "bitcoin" && s.native[0]?.coverage != null ? `, ${Math.round((s.native[0].coverage) * 100)}% of reserves sampled` : ""}</div></div>
        <div><div class="k">Withdrawals in flight</div><div class="v">{units(s.minter.pendingOut, d)}</div><div class="s">{s.minter.pendingOutCount ?? 0} requests, burned on the IC, native funds not yet final</div></div>
        <div><div class="k">Deposits awaiting mint</div><div class="v">{s.minter.pendingIn != null ? units(s.minter.pendingIn, d) : "not exposed"}</div></div>
        <div><div class="k">Raw ratio</div><div class="v">{pct(s.rec.rawRatio)}</div><div class="s">reserves over supply, no adjustments</div></div>
        <div><div class="k">Tolerance</div><div class="v">{pct(s.tolerance)}</div><div class="s">from this asset's own run-to-run noise, ceiling 1%</div></div>
        <div><div class="k">Checked</div><div class="v"><time datetime={isoDate(s.ts)} data-ago={s.ts}>{ago(s.ts)}</time></div></div>
      </div>

      <div class="sec-head"><h2>Reconciliation</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th></th><th>Line</th><th class="r">Amount</th><th>Trust</th><th class="hide-m">Note</th></tr></thead>
          <tbody>
            {s.rec.components.map((c) => (
              <tr>
                <td class="num muted">{c.sign > 0 ? "+" : c.sign < 0 ? "-" : ""}</td>
                <td style="font-weight:600">{c.label}</td>
                <td class="r num">{c.amount != null ? units(c.amount, d) : "unknown"}</td>
                <td><span class={`chip`}>{c.trust}</span></td>
                <td class="hide-m muted" style="font-size:12px">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="sec-head"><h2>Native sources</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Source</th><th class="r">Reading</th><th>Block</th><th>Coverage</th><th>Note</th></tr></thead>
          <tbody>
            {s.native.map((n) => (
              <tr>
                <td><a class="link" href={n.url ?? "#"} rel="noopener">{n.source}</a></td>
                <td class="r num">{n.value != null ? units(n.value, d) : "failed"}</td>
                <td class="num">{n.blockHeight ?? "n/a"}</td>
                <td>{n.complete ? "complete" : `${Math.round(n.coverage * 100)}% of reserves`}</td>
                <td class="muted" style="font-size:12px">{n.error ?? ""}</td>
              </tr>
            ))}
            <tr><td>Minter itself</td><td class="r num">{units(s.minter.reserves, d)}</td><td></td><td>complete</td><td class="muted" style="font-size:12px"><a class="link" href={s.minter.prov.url} rel="noopener">{s.minter.prov.source}</a></td></tr>
          </tbody>
        </table>
      </div>

      <div class="sec-head"><h2>Over time</h2><div class="filters" data-chart-group={`rs-${s.asset}`}>{["24h", "7d", "30d", "90d"].map((r) => <button type="button" class="fpill" data-range={r} aria-pressed={String(r === "7d")}>{r.toUpperCase()}</button>)}</div></div>
      <div class="grid-2" style="gap:16px">
        {([["ratio", "Reconciled backing ratio"], ["supply", `${s.symbol} supply`], ["reserves", "Minter reserves"], ["flows", "Supply change per interval (mints minus burns)"]] as [string, string][]).map(([m, title]) => (
          <div class="card">
            <div style="padding:14px 18px 0"><h3 style="font-size:13.5px;font-weight:700">{title}</h3></div>
            <div class="chart-box sm" id={`rs-${s.asset}-${m}`} data-group={`rs-${s.asset}`} data-range="7d" data-chart={`/api/v1/reserves/${s.asset}/series?metric=${m}`}></div>
          </div>
        ))}
      </div>

      <div class="sec-head"><h2>Canisters behind it</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Canister</th><th>Role</th><th class="r">Cycles</th><th>Runway</th><th>Health</th></tr></thead>
          <tbody>
            {[[minter, "Minter"], [ledger, "Ledger"]].map(([c, role]) => c && typeof c === "object" ? (
              <tr>
                <td><a class="name" href={`/canister/${c.id}`}><span><span class="t">{c.label}</span><span class="cid">{c.id}</span></span></a></td>
                <td>{role as string}</td>
                <td class="r num">{c.cycles != null ? fmtCycles(c.cycles) : "unknown"}</td>
                <td>{c.freeze_at ? `~${span(c.freeze_at - nowTs)}` : c.health === "healthy" ? "50+ y" : "n/a"}</td>
                <td><HealthPill health={c.health} /></td>
              </tr>
            ) : null)}
          </tbody>
        </table>
      </div>
      <p class="note" style="margin-top:10px">A minter running low on cycles is a reserve risk too: it holds the threshold key that moves the native funds. Lifeline alerts cover both canisters, and any controller or code change on them.</p>

      <div class="sec-head"><h2>Native addresses</h2></div>
      <div class="card">
        {s.minter.addresses.map((a) => (
          <div class="feed-item" style="border-bottom:1px solid var(--border)"><span class="d ok"></span><div style="min-width:0"><h4>{a.label}</h4><p class="mono" style="font-size:11.5px;word-break:break-all"><a class="link" href={a.url} rel="noopener">{a.address}</a></p></div></div>
        ))}
        {s.minter.addresses.length ? null : <Empty>No addresses exposed.</Empty>}
      </div>
      {Object.keys(s.minter.extra).length ? (
        <div class="card kv" style="margin-top:12px">
          {Object.entries(s.minter.extra).map(([k, v]) => <div><div class="k">{k.replace(/_/g, " ")}</div><div class="v mono" style="font-size:13px">{v == null ? "n/a" : String(v)}</div></div>)}
        </div>
      ) : null}

      <div class="prose" style="margin-top:30px">
        <h2>How to verify this yourself</h2>
        <ol>
          <li>Read the supply on the IC: call <code>icrc1_total_supply</code> on the ledger <code>{s.ledgerId}</code> (any IC client, or the dashboard link above).</li>
          <li>Read what the minter says it holds: open the minter's own dashboard at <a href={s.minter.prov.url}>{s.minter.prov.url}</a>. The minter is an NNS-controlled canister; its code is public and its upgrades are voted on.</li>
          <li>Check the native chain: look up the addresses above on any explorer. {s.chain === "bitcoin" ? "ckBTC funds sit in one address per depositor, all derived from the IC's threshold key, so a full check sums every address in the minter's UTXO table." : "The minter address holds the ETH and every ERC-20 balance; the helper contracts forward deposits to it."}</li>
          <li>Subtract withdrawals in flight (burned on the IC, funds not yet final on the native chain) and compare with the supply. That is the reconciled ratio above.</li>
        </ol>
      </div>
    </div>
  );
}

export { RangeTools };
