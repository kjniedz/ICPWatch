// /lifeline/calculator: what a canister costs, from the fee table or from a burn we measured.
import type { CanisterRow } from "../db/queries";
import { fmtCompact, fmtCycles, fmtNum, fmtUsd, span } from "../lib/format";
import { Crumbs, Fresh } from "../ui/components";

/** IC fee table for a 13-node application subnet, in cycles. 34-node subnets scale by 34/13. */
export const FEES = {
  ingress_message: 1_200_000, ingress_byte: 2_000, update_message: 5_000_000, instruction: 0.4, xnet_call: 260_000, xnet_byte: 1_000,
  storage_gib_second: 127_000, http_outcall_base: 3_000_000, http_outcall_request_byte: 60_000, http_outcall_response_byte: 800_000 / 1000,
  canister_create: 500_000_000_000,
};
export const FEE_SOURCE = "IC fee table (internetcomputer.org/docs/building-apps/essentials/gas-cost), 13-node subnet";

export interface CalcInput {
  mode: "estimate" | "measured"; nodes: 13 | 34;
  updates_per_day: number; instr_per_update: number; queries_per_day: number; ingress_kb: number; storage_gib: number; xnet_per_day: number; outcalls_per_day: number; outcall_kb: number;
  canister?: string;
}

export function parseCalc(qs: Record<string, string | undefined>): CalcInput {
  const n = (k: string, d: number) => { const raw = String(qs[k] ?? "").replace(/[,\s]/g, ""); if (!raw) return d; const v = Number(raw); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    mode: qs.canister ? "measured" : "estimate", nodes: qs.nodes === "34" ? 34 : 13,
    updates_per_day: n("updates_per_day", 10_000), instr_per_update: n("instr_per_update", 2_000_000), queries_per_day: n("queries_per_day", 100_000), ingress_kb: n("ingress_kb", 2), storage_gib: n("storage_gib", 1),
    xnet_per_day: n("xnet_per_day", 1_000), outcalls_per_day: n("outcalls_per_day", 0), outcall_kb: n("outcall_kb", 4), canister: qs.canister?.trim() || undefined,
  };
}

export interface CalcLine { label: string; cycles_day: number; note: string }

export function estimate(i: CalcInput): CalcLine[] {
  const m = i.nodes / 13;
  const lines: CalcLine[] = [
    { label: "Update calls", cycles_day: i.updates_per_day * (FEES.ingress_message + FEES.update_message + i.ingress_kb * 1024 * FEES.ingress_byte) * m, note: `${fmtNum(i.updates_per_day)} a day, ${i.ingress_kb} KB each: message reception, execution base, ingress bytes` },
    { label: "Instructions", cycles_day: i.updates_per_day * i.instr_per_update * FEES.instruction * m, note: `${fmtCompact(i.instr_per_update)} instructions per update at ${FEES.instruction} cycles each` },
    { label: "Query calls", cycles_day: 0, note: `${fmtNum(i.queries_per_day)} a day: queries are free to the canister today (replicas absorb them)` },
    { label: "Storage", cycles_day: i.storage_gib * FEES.storage_gib_second * 86400 * m, note: `${i.storage_gib} GiB at ${fmtNum(FEES.storage_gib_second)} cycles per GiB-second` },
    { label: "Inter-canister calls", cycles_day: i.xnet_per_day * (FEES.xnet_call + 1024 * FEES.xnet_byte) * m, note: `${fmtNum(i.xnet_per_day)} a day, 1 KB each` },
    { label: "HTTPS outcalls", cycles_day: i.outcalls_per_day * (FEES.http_outcall_base + i.outcall_kb * 1024 * FEES.http_outcall_response_byte) * m * (i.nodes / 13), note: `${fmtNum(i.outcalls_per_day)} a day, ${i.outcall_kb} KB responses; outcalls scale with subnet size twice (every node makes the call)` },
  ];
  return lines;
}

export function CalculatorPage({ input, lines, measured, rate, icpUsd, canisters }: {
  input: CalcInput; lines: CalcLine[]; measured: CanisterRow | null; rate: { xdrPermyriadPerIcp: number; ts: number } | null; icpUsd: number | null; canisters: { id: string; label: string }[];
}) {
  const perDay = input.mode === "measured" ? (measured?.burn_per_day ?? 0) : lines.reduce((s, l) => s + l.cycles_day, 0);
  const icpPerT = rate ? 10_000 / rate.xdrPermyriadPerIcp : null; // 1 T cycles = 1 XDR
  const icp = (cycles: number) => (icpPerT != null ? (cycles / 1e12) * icpPerT : null);
  const usd = (cycles: number) => { const v = icp(cycles); return v != null && icpUsd != null ? v * icpUsd : null; };
  const Money = ({ cycles }: { cycles: number }) => <>{fmtCycles(cycles)}{icp(cycles) != null ? <span class="muted"> · {icp(cycles)! >= 100 ? fmtNum(Math.round(icp(cycles)!)) : icp(cycles)!.toFixed(icp(cycles)! >= 1 ? 2 : 4)} ICP</span> : null}{usd(cycles) != null ? <span class="muted"> · {fmtUsd(usd(cycles)!)}</span> : null}</>;
  const runway = measured?.cycles != null && measured.burn_per_day ? measured.cycles / measured.burn_per_day : null;
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Lifeline", "/lifeline"], ["Cycles calculator", null]]} />
      <div class="page-head">
        <div>
          <h1>Cycles cost calculator</h1>
          <p class="lede">What a canister costs to run, either estimated from the IC fee table or taken from a burn ICPWatch has actually measured on a live canister. Cycles convert to ICP at the cycles minting canister's live XDR rate and to USD at our ICP price.</p>
        </div>
        <div class="page-actions"><Fresh ts={rate?.ts ?? null} source={`CMC get_icp_xdr_conversion_rate${icpUsd != null ? ` + ICPWatch ICP price ${fmtUsd(icpUsd)}` : ""}`} staleAfter={7200} label="rate" /></div>
      </div>

      <div class="card statbar">
        <div><div class="v"><Money cycles={perDay} /></div><div class="k">Per day</div></div>
        <div><div class="v"><Money cycles={perDay * 30} /></div><div class="k">Per 30 days</div></div>
        <div><div class="v"><Money cycles={perDay * 365} /></div><div class="k">Per year</div></div>
        {icpPerT != null ? <div><div class="v">{icpPerT.toFixed(4)} ICP</div><div class="k">per trillion cycles (1 XDR) right now</div></div> : null}
      </div>

      <div class="grid-2" style="margin-top:16px;align-items:start">
        <form class="card card-pad form" method="get" action="/lifeline/calculator">
          <h2 style="margin-top:0">Estimate</h2>
          <div class="grid-2" style="gap:10px">
            <label class="sub"><span>Update calls per day</span><input name="updates_per_day" inputmode="numeric" value={String(input.updates_per_day)} /></label>
            <label class="sub"><span>Instructions per update</span><input name="instr_per_update" inputmode="numeric" value={String(input.instr_per_update)} /></label>
            <label class="sub"><span>Query calls per day</span><input name="queries_per_day" inputmode="numeric" value={String(input.queries_per_day)} /></label>
            <label class="sub"><span>Ingress KB per update</span><input name="ingress_kb" inputmode="decimal" value={String(input.ingress_kb)} /></label>
            <label class="sub"><span>Storage (GiB)</span><input name="storage_gib" inputmode="decimal" value={String(input.storage_gib)} /></label>
            <label class="sub"><span>Inter-canister calls per day</span><input name="xnet_per_day" inputmode="numeric" value={String(input.xnet_per_day)} /></label>
            <label class="sub"><span>HTTPS outcalls per day</span><input name="outcalls_per_day" inputmode="numeric" value={String(input.outcalls_per_day)} /></label>
            <label class="sub"><span>Outcall response KB</span><input name="outcall_kb" inputmode="decimal" value={String(input.outcall_kb)} /></label>
            <label class="sub"><span>Subnet</span><select class="input" name="nodes"><option value="13" selected={input.nodes === 13}>13 nodes (application)</option><option value="34" selected={input.nodes === 34}>34 nodes (fiduciary, 2.6x)</option></select></label>
          </div>
          <div style="margin-top:12px"><button class="btn btn-primary" type="submit">Calculate</button></div>
        </form>
        <form class="card card-pad form" method="get" action="/lifeline/calculator">
          <h2 style="margin-top:0">Measured burn</h2>
          <p class="note" style="margin-top:0">Use the burn ICPWatch measured on a canister it watches. This is what the canister actually spends, whatever the fee table says.</p>
          <label class="sub"><span>Canister</span>
            <input name="canister" list="watched" value={input.canister ?? ""} placeholder="canister id, or pick one" autocomplete="off" spellcheck={false} />
            <datalist id="watched">{canisters.map((c) => <option value={c.id}>{c.label}</option>)}</datalist>
          </label>
          <div style="margin-top:12px"><button class="btn btn-primary" type="submit">Use measured burn</button></div>
          {measured ? (
            <div class="callout" style="margin-top:12px">
              <b>{measured.label}</b> burns <b>{measured.burn_per_day != null ? fmtCycles(measured.burn_per_day) : "unknown"}</b> a day ({measured.burn_source ?? "observed"}, {measured.baseline_days ?? "?"} days of baseline), holds {measured.cycles != null ? fmtCycles(measured.cycles) : "unknown"}{runway ? `, ${span(runway * 86400)} of runway` : ""}. <a class="link" href={`/canister/${measured.id}`}>Canister page</a>
            </div>
          ) : input.canister ? <div class="callout warn" style="margin-top:12px">Not watched yet. <a class="link" href={`/canister/${input.canister}`}>Add it</a> and come back once a burn has been measured.</div> : null}
        </form>
      </div>

      {input.mode === "estimate" ? (
        <>
          <div class="sec-head"><h2>Breakdown</h2><span class="note">{FEE_SOURCE}</span></div>
          <div class="card tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th class="r">Cycles per day</th><th class="r hide-m">Share</th><th class="hide-m">Basis</th></tr></thead>
              <tbody>{lines.map((l) => <tr><td>{l.label}</td><td class="r num">{fmtCycles(l.cycles_day)}</td><td class="r num hide-m">{perDay ? `${((l.cycles_day / perDay) * 100).toFixed(0)}%` : ""}</td><td class="hide-m muted" style="font-size:12px">{l.note}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      ) : null}
      <div class="src" style="margin-top:10px">Fee table constants: ingress message {fmtNum(FEES.ingress_message)}, ingress byte {fmtNum(FEES.ingress_byte)}, update execution base {fmtNum(FEES.update_message)}, {FEES.instruction} cycles per instruction, storage {fmtNum(FEES.storage_gib_second)} per GiB-second, inter-canister call {fmtNum(FEES.xnet_call)} plus {fmtNum(FEES.xnet_byte)} per byte, HTTPS outcall {fmtNum(FEES.http_outcall_base)} base. Canister creation costs {fmtCycles(FEES.canister_create)} once. Fees change by NNS proposal; the measured mode is immune to that.</div>
    </div>
  );
}
