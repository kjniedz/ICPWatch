import { raw } from "hono/html";
import { fmtCycles, fmtUsd, isoDate, shortDate, span, now, ago } from "../lib/format";
import type { FundingOptions, Preset } from "../fund/calc";
import { TPUP_MEMO_DECIMAL, type DepositRow } from "../fund";
import { qrSvg } from "../fund/qr";
import { Empty } from "../ui/components";

export interface FundData { options: FundingOptions; account: string; totals: { topups: number; cycles: number; e8s: number; supporters: number }; deposits: DepositRow[] }

const icp = (e8s: number | null) => (e8s == null ? "n/a" : `${(e8s / 1e8).toFixed(4)} ICP`);
const short = (a: string) => `${a.slice(0, 10)}...${a.slice(-6)}`;

/** When the safe cap flattens several presets to the same amount, show that amount once. */
const dedupe = (ps: Preset[]) => ps.filter((p, i) => ps.findIndex((x) => x.deliveredCycles === p.deliveredCycles) === i);

function PresetRow({ p, state, selected }: { p: Preset; state: string; selected: boolean }) {
  const after = p.afterShareOfThreshold != null ? `${Math.round(p.afterShareOfThreshold * 100)}% of the freezing threshold` : null;
  return (
    <label class={`check fund-preset${selected ? " on" : ""}`} data-preset={p.key} data-e8s={p.totalE8s ?? ""} data-cycles={p.deliveredCycles}>
      <input type="radio" name={`preset-${p.mode}`} value={p.key} checked={selected} />
      <span style="flex:1">
        <b>{p.label}{p.capped ? <span class="chip" style="margin-left:6px">capped</span> : null}</b>
        <span style="display:block;font-size:12px;color:var(--text-2)">
          {fmtCycles(p.deliveredCycles)} cycles = {icp(p.totalE8s)}{p.usd != null ? ` (${fmtUsd(p.usd)})` : ""} incl. fee
        </span>
        <span style="display:block;font-size:11.5px;color:var(--muted)">
          {p.mode === "keep_alive" ? `buys ${Math.round(p.daysBought)} days of preservation${after ? `, balance stays at ${after}` : ""}${p.newDeleteAt ? `, deletion moves to ${shortDate(p.newDeleteAt)}` : ""}` : `${state === "frozen" ? "unfreezes the canister and " : ""}covers ${Math.round(p.daysBought)} days of normal burn${p.newFreezeAt ? `, would freeze again around ${shortDate(p.newFreezeAt)}` : ""}`}
        </span>
        {p.unfreezes && p.mode === "keep_alive" ? <span class="chip chip-dead">would unfreeze</span> : null}
      </span>
    </label>
  );
}

/** The full "Fund this canister" panel. Server-rendered; client/fund.ts adds intent registration, live status, and wallets. */
export function FundPanel({ canisterId, label, data }: { canisterId: string; label: string; data: FundData }) {
  const o = data.options;
  const keepOk = o.keepAlive.available;
  const reviveOk = o.revive.available;
  const defaultMode = keepOk ? "keep_alive" : "revive";
  const stateText: Record<string, string> = {
    frozen: "This canister is frozen: it rejects calls and burns only storage cost until it hits zero and is deleted.",
    at_risk: "This canister is running but low on cycles.", running: "This canister is running with a healthy balance.",
    uninstalled: "This canister has been uninstalled: its code and state are gone. Cycles sent here only preserve an empty shell.",
    deleted: "This canister no longer exists.", unknown: "This canister's balance cannot be read from outside.",
  };
  return (
    <div class="card fund" id="fund" data-fund={canisterId} data-account={data.account}>
      <div class="card-pad" style="border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline">
          <h3 style="font-size:16px;font-weight:700">Fund this canister</h3>
          <span class="muted" style="font-size:12px">{data.totals.topups ? `${data.totals.topups} community top-ups · ${fmtCycles(data.totals.cycles)} cycles from ${data.totals.supporters} supporter${data.totals.supporters === 1 ? "" : "s"}` : "no community top-ups yet"}</span>
        </div>
        <p style="font-size:13px;color:var(--text-2);margin-top:6px">
          {stateText[o.state] ?? ""} Balance {o.balanceCycles != null ? fmtCycles(o.balanceCycles) : "unknown"}{o.idleBurnPerDay != null ? `, idle burn ${fmtCycles(o.idleBurnPerDay)}/day${o.estimated ? " (estimated from its own decline)" : ""}` : ""}{o.currentDeleteAt ? `, deletion in about ${span(o.currentDeleteAt - now())}` : ""}.
        </p>
        {o.warnings.map((w) => <div class={`callout${w.level === "danger" ? " warn" : ""}`} style="margin-top:8px;font-size:12.5px">{w.text}</div>)}
      </div>

      <div class="card-pad" style="border-bottom:1px solid var(--border)">
        <div class="seg" role="radiogroup" aria-label="Mode" data-fund-modes>
          <label><input type="radio" name="mode" value="keep_alive" checked={defaultMode === "keep_alive"} disabled={!keepOk} />Keep alive</label>
          <label><input type="radio" name="mode" value="revive" checked={defaultMode === "revive"} disabled={!reviveOk} />Revive</label>
        </div>
        {([["keep_alive", o.keepAlive, "Keep alive: the minimum that prevents deletion while keeping the canister frozen and cheap. It stays below its freezing threshold on purpose."], ["revive", o.revive, "Revive: enough to bring it above the freezing threshold and running again. A revived canister burns at its normal rate again, so it needs a controller or a community that keeps funding it."]] as const).map(([mode, m, blurb]) => (
          <div data-fund-mode={mode} hidden={mode !== defaultMode} style="margin-top:12px">
            <p class="note" style="margin-bottom:10px">{blurb}</p>
            {m.available ? (
              <div class="stack" style="gap:8px">{dedupe(m.presets).map((p, i) => <PresetRow p={p} state={o.state} selected={i === 0} />)}</div>
            ) : <div class="callout warn">{m.reason ?? "Not available."}</div>}
            {m.warnings.map((w) => <div class={`callout${w.level === "danger" ? " warn" : ""}`} style="margin-top:8px;font-size:12.5px">{w.text}</div>)}
            {m.requiresAck ? <label class="check" style="margin-top:10px"><input type="checkbox" name="ack" /><span>I understand this canister has no code and cycles sent here only keep an empty shell alive.</span></label> : null}
          </div>
        ))}
      </div>

      <div class="card-pad" style="border-bottom:1px solid var(--border)">
        <div class="seg" role="radiogroup" aria-label="How to pay" data-fund-methods>
          <label><input type="radio" name="method" value="deposit" checked />Send ICP from any wallet</label>
          <label><input type="radio" name="method" value="wallet" />Connect a wallet</label>
        </div>
        <div data-fund-method="deposit" style="margin-top:14px;display:grid;grid-template-columns:184px 1fr;gap:18px;align-items:start" class="fund-deposit">
          <div style="border-radius:10px;overflow:hidden;background:#fff;line-height:0">{raw(qrSvg(data.account, { title: "Top-up account" }))}</div>
          <div style="min-width:0;font-size:13px">
            <div class="k" style="font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)">Top-up account (ICP account id)</div>
            <div class="mono" style="font-size:12px;word-break:break-all;margin:4px 0">{data.account} <button type="button" class="copy" data-copy={data.account}>copy</button></div>
            <div class="k" style="font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-top:8px">Memo (required)</div>
            <div class="mono" style="font-size:12px;margin:4px 0">{TPUP_MEMO_DECIMAL} <button type="button" class="copy" data-copy={TPUP_MEMO_DECIMAL}>copy</button> <span class="muted" style="font-size:11px">("TPUP" as a number)</span></div>
            <div class="k" style="font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-top:8px">Amount</div>
            <div class="mono" style="font-size:13px;font-weight:700;margin:4px 0" data-fund-amount>{icp((keepOk ? o.keepAlive : o.revive).presets[0]?.totalE8s ?? null)}</div>
            <p class="note" style="margin-top:8px">
              This is the canister's own top-up account on the Cycles Minting Canister, not an ICPWatch address. The memo is what tells the CMC which canister to credit: a transfer without it is refunded automatically by the CMC (minus the ledger fee), so exchanges that cannot set a memo will not work.
              Once ICP lands, ICPWatch asks the CMC to convert it; nothing else is needed.
            </p>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
              <button type="button" class="btn btn-primary btn-sm" data-fund-sent>I sent it</button>
              <span class="muted" style="font-size:12px" data-fund-status>Waiting: the account is checked every few minutes for a day after you click.</span>
            </div>
          </div>
        </div>
        <div data-fund-method="wallet" hidden style="margin-top:14px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button type="button" class="btn btn-primary btn-sm" data-wallet="plug">Connect Plug</button>
            <span class="chip">beta</span>
            <span class="muted" style="font-size:12px">Internet Identity, Oisy, and NFID are coming. Plug transfers ICP with the TPUP memo straight to the top-up account; ICPWatch then notifies the CMC.</span>
          </div>
          <div class="muted" style="font-size:12px;margin-top:8px" data-wallet-status></div>
        </div>
      </div>

      <div class="card-pad">
        <p class="note">
          Non-custodial and non-refundable: ICP goes to the canister through the CMC and becomes that canister's cycles. ICPWatch never holds it and cannot reverse it. Anyone may top up any canister; that is how the Internet Computer works. Top-ups appear in the public record below once the CMC has credited them.
        </p>
      </div>
      {data.deposits.length ? <SupportersList rows={data.deposits} compact /> : null}
    </div>
  );
}

/** Compact link for table rows of frozen or low canisters. */
export const FundLink = ({ canisterId }: { canisterId: string }) => <a class="fpill" href={`/canister/${canisterId}#fund`} style="padding:3px 10px;font-size:11px">Fund</a>;

const STATUS_TEXT: Record<string, string> = { pending: "pending", converting: "converting", credited: "credited", refunded: "refunded by CMC", failed: "failed", too_old: "too old to notify", wrong_memo: "no memo, refunded" };

export function SupportersList({ rows, compact }: { rows: (DepositRow & { canister_id?: string; label?: string | null })[]; compact?: boolean }) {
  return (
    <div class={compact ? "" : "card"} style={compact ? "border-top:1px solid var(--border)" : ""}>
      <table class="tbl">
        <thead><tr>{compact ? null : <th>Canister</th>}<th>Supporter</th><th class="r">Sent</th><th class="r">Credited</th><th>Bought</th><th>Status</th><th>When</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const days = r.cycles && r.idle_burn_per_day ? r.cycles / r.idle_burn_per_day : null;
            return (
              <tr>
                {compact ? null : <td><a href={`/canister/${r.canister_id}#fund`} style="font-weight:600">{r.label ?? r.canister_id}</a></td>}
                <td>{r.display_name ? (r.display_link ? <a class="link" href={r.display_link} rel="noopener nofollow ugc">{r.display_name}</a> : <b>{r.display_name}</b>) : <a class="mono" style="font-size:11.5px" href={`/account/${r.from_account}`}>{short(r.from_account)}</a>}</td>
                <td class="r num">{icp(r.e8s)}</td>
                <td class="r num">{r.cycles != null ? fmtCycles(r.cycles) : "n/a"}</td>
                <td class="muted" style="font-size:12px">{r.mode === "revive" ? "revive" : days != null ? `${Math.round(days)} days of preservation` : r.mode ?? ""}</td>
                <td><span class={`pill ${r.status === "credited" ? "ok" : r.status === "pending" || r.status === "converting" ? "risk" : "low"}`}>{STATUS_TEXT[r.status] ?? r.status}</span></td>
                <td><time datetime={isoDate(r.credited_at ?? r.seen_at)} data-ago={r.credited_at ?? r.seen_at}>{ago(r.credited_at ?? r.seen_at)}</time></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length ? null : <Empty>No community top-ups recorded yet.</Empty>}
    </div>
  );
}
