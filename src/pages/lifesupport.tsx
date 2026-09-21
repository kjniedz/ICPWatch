// "On Life Support" adoption registry with real cost numbers and the public audit log.
// Drop-in replacement for LifeSupportPage in content.tsx: feed it registry(env) from src/lifesupport.
import { fmtCycles, fmtUsd, now, shortDate, shortId, span } from "../lib/format";
import { Crumbs, Empty } from "../ui/components";
import type { AuditRow, Candidate, CostView, PreservedItem, RegistryData } from "../lifesupport/engine";

const icp = (n: number | null | undefined) => (n == null ? "n/a" : n >= 1 ? `${n.toFixed(2)} ICP` : n >= 0.001 ? `${n.toFixed(4)} ICP` : `${n.toFixed(6)} ICP`);

function Cost({ c }: { c: CostView | null }) {
  if (!c) return <span class="muted">not computable yet</span>;
  return <span title={`about ${c.topUpsPerMonth.toFixed(1)} top-ups a month, ledger fees included`}>{fmtCycles(c.cycles)} &middot; {icp(c.icp)} &middot; {fmtUsd(c.usd)}</span>;
}

function Preserved({ l }: { l: PreservedItem }) {
  const pct = l.budgetCycles > 0 ? Math.min(100, Math.round((l.spentCycles / l.budgetCycles) * 100)) : 0;
  return (
    <div class="card adopt">
      <div class="b">
        <h4><a href={`/canister/${l.canisterId}`}>{l.label ?? l.canisterId}</a> {l.state !== "active" ? <span class="pill unk">{l.state}{l.adoptedBy ? ` by ${l.adoptedBy}` : ""}</span> : null}</h4>
        <p>{l.what}</p>
        {l.story ? <p class="muted" style="font-size:12px">{l.story}</p> : null}
        <small>
          preserved for {span(now() - l.since)} &middot; costs <Cost c={l.monthly} /> per month
          <br />
          spent {fmtCycles(l.spentCycles)} of {fmtCycles(l.budgetCycles)} budget ({pct}%){l.remainingMonths != null ? `, about ${l.remainingMonths >= 24 ? `${(l.remainingMonths / 12).toFixed(1)} years` : `${Math.round(l.remainingMonths)} months`} left at this rate` : ""}
          {" "}&middot; {l.topUps} top-up{l.topUps === 1 ? "" : "s"}{l.lastTopUpAt ? `, last ${shortDate(l.lastTopUpAt)}` : ""}
          {l.cycles != null && l.thresholdCycles ? <> &middot; balance {fmtCycles(l.cycles)} = {Math.round((l.cycles / l.thresholdCycles) * 100)}% of its freezing threshold (frozen on purpose)</> : null}
        </small>
      </div>
      {l.state === "active" ? <a class="btn btn-primary btn-sm" href={`/contact?adopt=${l.canisterId}`}>Adopt</a> : null}
    </div>
  );
}

function Candidates({ items }: { items: Candidate[] }) {
  if (!items.length) return <div class="card"><Empty>No watched canister is frozen right now.</Empty></div>;
  return (
    <div class="card tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Canister</th><th class="r">Cycles</th><th>Deletion</th><th class="r">Cost to preserve / month</th><th class="r hide-m">Per year</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr>
              <td><a class="name" href={`/canister/${c.canisterId}`}><span><span class="t">{c.label}{c.tokenSymbol ? ` (${c.tokenSymbol})` : ""}</span><span class="cid">{c.canisterId}</span></span></a></td>
              <td class="r num">{c.cycles != null ? fmtCycles(c.cycles) : "unknown"}</td>
              <td>{c.deleteAt ? `${shortDate(c.deleteAt)} (${span(c.deleteAt - now())})` : "not projectable"}</td>
              <td class="r num">{c.monthly ? <Cost c={c.monthly} /> : <span class="muted" title={c.why ?? ""}>not computable</span>}</td>
              <td class="r num hide-m">{c.yearlyUsd != null ? fmtUsd(c.yearlyUsd) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const stageLabel: Record<string, string> = { reserve: "budget reserved", verify: "top-up verified", release: "reservation released", anomaly: "anomaly", admin: "admin", plan: "refused" };

function Audit({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <div class="card"><Empty>No top-ups yet. Every top-up, refusal, and admin action will be listed here, and rows can never be edited or removed.</Empty></div>;
  return (
    <div class="card tbl-wrap">
      <table class="tbl">
        <thead><tr><th>When (UTC)</th><th>Canister</th><th>Event</th><th class="r">Cycles</th><th class="r hide-m">Before</th><th class="r hide-m">After</th><th class="hide-m">ICP ledger block</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr title={a.note ?? ""}>
              <td class="num">{new Date(a.ts * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
              <td>{a.canister_id ? <a href={`/canister/${a.canister_id}`} class="mono">{shortId(a.canister_id)}</a> : <span class="muted">global</span>}</td>
              <td><span class={`pill ${a.ok ? "ok" : a.stage === "anomaly" ? "low" : "unk"}`}>{stageLabel[a.stage] ?? a.stage}</span> <span class="muted" style="font-size:12px">{a.code.replace(/_/g, " ")}</span></td>
              <td class="r num">{a.minted_cycles != null ? fmtCycles(a.minted_cycles) : a.cost_cycles != null ? fmtCycles(a.cost_cycles) : ""}</td>
              <td class="r num hide-m">{a.before_cycles != null ? fmtCycles(a.before_cycles) : ""}</td>
              <td class="r num hide-m">{a.after_cycles != null ? `${fmtCycles(a.after_cycles)}${a.after_frozen === 1 ? ", still frozen" : a.after_frozen === 0 ? ", NOT frozen" : ""}` : ""}</td>
              <td class="hide-m num">{a.ledger_block != null ? a.ledger_block : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LifeSupportRegistryPage({ data, adopt }: { data: RegistryData; adopt: string | null }) {
  const t = data.totals;
  const fundable = data.candidates.filter((c) => c.monthly);
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Lifeline", "/lifeline"], ["On Life Support", null]]} />
      <div class="page-head">
        <div>
          <h1>On Life Support <span class="badge-only">Adoption registry</span></h1>
          <p class="lede">Abandoned canisters kept from deletion at minimum cost, so a project or community can claim them and bring them back.</p>
        </div>
      </div>

      <div class="callout" style="margin-bottom:22px">
        {data.active ? (
          <><b>Status: active.</b> Top-ups are running inside a global cap of {fmtCycles(t.globalCapCycles)} ({fmtCycles(t.globalSpentCycles)} spent so far). Every one is listed in the audit log below.</>
        ) : (
          <><b>Status: not spending.</b> {data.killSwitch ? "The kill switch is engaged." : "The funded path is switched off."} Plans are still computed in dry-run mode, so every cost on this page is a real number: what preservation would cost today.</>
        )}
      </div>

      <div class="stats" style="margin-bottom:22px">
        <div class="card stat"><div class="k">Preserved</div><div class="v">{data.preserved.filter((p) => p.state === "active").length}</div><div class="s">{fmtUsd(t.monthlyUsd)} / month in total</div></div>
        <div class="card stat"><div class="k">Spent so far</div><div class="v">{fmtCycles(t.spentCycles)}</div><div class="s">cap {fmtCycles(t.globalCapCycles)}</div></div>
        <div class="card stat"><div class="k">Frozen candidates</div><div class="v">{data.candidates.length}</div><div class="s">{fundable.length ? `${fmtUsd(t.candidateMonthlyUsd)} / month would hold all ${fundable.length} priceable ones` : "none priceable yet"}</div></div>
      </div>

      <div class="sec-head" style="margin-top:0"><h2>Preserved canisters</h2></div>
      {data.preserved.length ? <div class="stack">{data.preserved.map((l) => <Preserved l={l} />)}</div> : <div class="card"><Empty>No canisters are on life support yet.</Empty></div>}

      <div class="sec-head"><h2>Candidates: frozen right now</h2></div>
      <Candidates items={data.candidates} />
      <p class="muted" style="font-size:12px;margin-top:8px">
        Cost = the canister's idle (storage) burn plus one 0.0001 ICP ledger fee per refill, shown as cycles, ICP, and USD
        {data.xdrPermyriadPerIcp ? ` at ${(data.xdrPermyriadPerIcp / 1e4).toFixed(4)} XDR per ICP (cycles minting canister${data.rateAt ? `, ${shortDate(data.rateAt)}` : ""})` : ""} and {data.usdPerXdr.toFixed(2)} USD per XDR ({data.usdSource === "icp-price" ? "from our ICP price" : "approximate"}). 1 T cycles always costs 1 XDR, so the cycles figure is the stable one.
      </p>

      <div class="sec-head"><h2>Audit log</h2></div>
      <Audit rows={data.audit} />

      <div class="prose" style="margin-top:34px" id="adopt">
        <h2>How life support works</h2>
        <p><strong>Preservation, not restoration.</strong> A frozen canister burns only its idle storage cost. If the balance reaches zero the canister is uninstalled and its state is deleted. Life support sends small top-ups so the balance stays above zero but below the freezing threshold. The canister stays frozen on purpose, which is the cheapest state in which it still exists.</p>
        <p><strong>Sized per canister.</strong> Each top-up targets at most 45% of that canister's own freezing threshold, computed from a certified reading of its idle burn and threshold setting. Even if a top-up were applied twice it could not unfreeze the canister. State is verified after every top-up, and anything unexpected stops all spending automatically until a person has looked.</p>
        <p><strong>Hard limits.</strong> A global spend cap, a budget per canister, a manual kill switch, and an append-only audit log of every top-up, published above. The limits are enforced by the database itself, not only by code.</p>
        <p><strong>Running canisters are never funded.</strong> If someone else tops a preserved canister up past its threshold, life support steps back and flags it.</p>
        <h2>Adopting a canister</h2>
        <p>If you are the original team, or a community that wants to revive a project, <a href={adopt ? `/contact?adopt=${adopt}` : "/contact"}>get in touch</a>. Adoption means the existing controllers (or the SNS, for DAO-controlled canisters) take funding back over. ICPWatch never takes control of a canister: top-ups are permissionless deposits and nothing more.</p>
      </div>
    </div>
  );
}
