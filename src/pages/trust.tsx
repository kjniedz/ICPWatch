import { ago, isoDate } from "../lib/format";
import {
  CAP_FROZEN_LEDGER, CAP_ONE_MISSING, CAP_TWO_MISSING, CONTROL_LABELS, CONTROL_POINTS, DEPTH_STEPS, GRADE_STEPS, HEALTH_POINTS, HISTORY_RULES, HOLDER_STEPS,
  MAX_POINTS, METHOD_VERSION, MINTER_LABELS, MINTER_POINTS, MINT_CAP_BY_CONTROL, MIN_MEASURED_SHARE, RATIO_STEPS, SPREAD_STEPS, STALE_AFTER, type Grade, type TrustFactor, type TrustResult,
} from "../trust/score";
import type { TrustSummary } from "../trust/collect";
import { Crumbs } from "../ui/components";

export interface StoredTrust { token_id: string; score: number | null; grade: Grade; insufficient: number; factors: string; summary: string; method_version: string; computed_at: number }

const GRADE_CLASS: Record<Grade, string> = { A: "ok", B: "ok", C: "risk", D: "low", E: "frozen", DEAD: "frozen", NA: "unk" };

/** Compact grade chip for lists. "n/a" is "insufficient data", never a good-looking default. */
export function TrustBadge({ grade, score, tier }: { grade: Grade; score: number | null; tier?: string }) {
  const text = grade === "DEAD" ? "Dead ledger" : grade === "NA" ? "Insufficient data" : `${grade} · ${score}`;
  return <span class={`pill ${GRADE_CLASS[grade]}`} title={tier ? `${tier}. Trust score methodology: /trust-score` : "Trust score methodology: /trust-score"}>{text}</span>;
}

export function parseStored(row: StoredTrust | null): { factors: TrustFactor[]; summary: TrustSummary } | null {
  if (!row) return null;
  try {
    return { factors: JSON.parse(row.factors) as TrustFactor[], summary: JSON.parse(row.summary) as TrustSummary };
  } catch {
    return null;
  }
}

/** The full panel on a token page: every factor with its state, points, explanation, and evidence links. */
export function TrustPanel({ row }: { row: StoredTrust | null }) {
  const p = parseStored(row);
  if (!row || !p) {
    return (
      <div class="card card-pad">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><TrustBadge grade="NA" score={null} /><span class="muted" style="font-size:13px">Not scored yet. The trust collector runs hourly.</span></div>
      </div>
    );
  }
  const { factors, summary } = p;
  return (
    <div class="card">
      <div class="card-pad" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border)">
        <TrustBadge grade={row.grade} score={row.score} tier={summary.tier} />
        <div style="flex:1;min-width:220px;font-size:13px;color:var(--text-2)">
          {summary.dead ? "The ledger canister has been uninstalled. Balances and transfers no longer exist, so nothing else about this token matters." :
            row.insufficient ? <>Insufficient data: {summary.reasons.join("; ")}.</> :
            <>{summary.pointsEarned} of {summary.pointsMeasured} measurable points{summary.pointsMeasured < summary.pointsPossible ? ` (${summary.pointsPossible} possible)` : ""}{summary.band ? `, range ${summary.band.low} to ${summary.band.high} once every factor is measured` : ""}.</>}
          {summary.caps.length ? <div class="src" style="margin-top:4px">Capped: {summary.caps.map((c) => `${c.reason} (max ${c.maxScore})`).join("; ")}</div> : null}
        </div>
        <div style="text-align:right;font-size:11.5px;color:var(--muted)">
          method v{row.method_version} &middot; <time datetime={isoDate(row.computed_at)} data-ago={row.computed_at}>{ago(row.computed_at)}</time><br />
          <a class="link" href="/trust-score">How this is scored</a>
        </div>
      </div>
      <div>
        {factors.map((f) => (
          <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:170px 1fr auto;gap:14px;align-items:start" class="trust-row">
            <div><div style="font-weight:600;font-size:13px">{f.label}</div><div class="src">{f.missing ? "missing" : f.stateLabel}</div></div>
            <div style="font-size:12.5px;color:var(--text-2)">
              {f.explanation}
              {f.evidence.length ? (
                <div style="margin-top:5px;display:flex;gap:6px 14px;flex-wrap:wrap;font-size:11.5px">
                  {f.evidence.map((e) => <span>{e.label}: {e.href ? <a class="link" href={e.href}>{e.value}</a> : <span class="mono">{e.value}</span>}</span>)}
                </div>
              ) : null}
              {f.dataAsOf ? <div class="src" style="margin-top:3px">data as of <time datetime={isoDate(f.dataAsOf)} data-ago={f.dataAsOf}>{ago(f.dataAsOf)}</time> &middot; <a class="link" href={f.evidenceHref}>evidence</a></div> : null}
            </div>
            <div class="num" style={`font-weight:700;font-size:15px;white-space:nowrap;${f.missing ? "color:var(--muted)" : ""}`}>{f.missing ? "?" : f.points} <span class="muted" style="font-size:11px;font-weight:500">/ {f.maxPoints}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Steps = ({ rows }: { rows: [string, string | number][] }) => (
  <table><thead><tr><th>Condition</th><th>Points</th></tr></thead><tbody>{rows.map(([c, p]) => <tr><td>{c}</td><td>{p}</td></tr>)}</tbody></table>
);

export function TrustMethodologyPage() {
  const h = HEALTH_POINTS;
  return (
    <div class="wrap page narrow prose">
      <Crumbs items={[["Markets", "/markets"], ["Trust score", null]]} />
      <h1>Token trust score</h1>
      <p class="lede">One score per token, 0 to 100, built from six factors that are each measured from public data and shown with their evidence. Method version {METHOD_VERSION}. Projects that disagree with a score can point at the exact factor and the exact input, which is the point.</p>

      <h2>What the score is and is not</h2>
      <p>It measures how much you have to trust the people behind a token before you hold it: who can change the ledger, who can create supply, how concentrated the float is, whether you can get out, whether the canisters that hold your balance are healthy, and whether control or code changed recently. It says nothing about whether the project is any good. A perfectly fair meme coin can score A; a serious project run from one developer's principal cannot score above C on control alone.</p>

      <h2>Factors and points</h2>
      <table>
        <thead><tr><th>Factor</th><th>Max points</th><th>Measures</th></tr></thead>
        <tbody>
          <tr><td>Ledger control</td><td>{MAX_POINTS.control}</td><td>Who is in the ledger canister's controller list, read from the certified state tree.</td></tr>
          <tr><td>Mint authority</td><td>{MAX_POINTS.mint}</td><td>Who owns <code>icrc1_minting_account</code>, and what controls that principal. Capped by ledger control, because whoever can upgrade the ledger can mint anyway.</td></tr>
          <tr><td>Holder concentration</td><td>{MAX_POINTS.holders}</td><td>Share of free float held by the {"10"} largest accounts, from our own block index, only once the index has reconciled against total supply.</td></tr>
          <tr><td>Liquidity depth</td><td>{MAX_POINTS.liquidity}</td><td>Token-side USD depth across DEX pools, depth relative to market cap, and how spread the liquidity is across pools.</td></tr>
          <tr><td>Canister health</td><td>{MAX_POINTS.health}</td><td>The worst Lifeline state across the ledger, index, and archives.</td></tr>
          <tr><td>Upgrade and controller history</td><td>{MAX_POINTS.history}</td><td>Controller changes, reinstalls, and upgrade frequency from the on-chain change log, weighted by who governs the ledger.</td></tr>
        </tbody>
      </table>

      <h3>Ledger control</h3>
      <Steps rows={(Object.keys(CONTROL_POINTS) as (keyof typeof CONTROL_POINTS)[]).map((k) => [CONTROL_LABELS[k], CONTROL_POINTS[k]])} />
      <p>NNS and blackholed ledgers score full marks: nobody can change them unilaterally. An SNS ledger can be upgraded, but only by a proposal the token holders vote on. A ledger controlled by an ordinary canister scores by what controls that canister. One or several principals is the weakest case: those keys can do anything, at any time, with no notice.</p>

      <h3>Mint authority</h3>
      <Steps rows={(Object.keys(MINTER_POINTS) as (keyof typeof MINTER_POINTS)[]).map((k) => [MINTER_LABELS[k], MINTER_POINTS[k]])} />
      <p>Cap by ledger control: {(Object.keys(MINT_CAP_BY_CONTROL) as (keyof typeof MINT_CAP_BY_CONTROL)[]).map((k) => `${CONTROL_LABELS[k]} ${MINT_CAP_BY_CONTROL[k]}`).join(", ")}.</p>

      <h3>Holder concentration</h3>
      <Steps rows={HOLDER_STEPS.map((s) => [s.max === Infinity ? "top 10 hold more than 85% of free float" : `top 10 hold at most ${Math.round(s.max * 100)}% of free float`, s.points])} />
      <p><strong>Free float excludes protocol-held balances</strong>, so a DAO is not penalised for holding its own treasury: SNS treasuries and governance (neuron stakes live in governance subaccounts), SNS swaps, DEX pools, minters, and burn addresses are taken out of both the numerator and the denominator. The exclusions come from the <a href="/labels">entity labels</a>, and the token's own governance principal is always excluded even without a label. Every excluded account is listed as evidence. This factor is only measured once our block index has replayed the whole ledger and the sum of balances matched <code>icrc1_total_supply</code> exactly; until then it is missing.</p>

      <h3>Liquidity depth</h3>
      <Steps rows={[...DEPTH_STEPS.filter((s) => s.min > 0).map((s) => [`token-side depth of at least $${s.min.toLocaleString("en-US")}`, s.points] as [string, number]), ...RATIO_STEPS.filter((s) => s.min > 0).map((s) => [`depth at least ${s.min * 100}% of market cap (SNS and community tokens)`, s.points] as [string, number]), ...SPREAD_STEPS.map((s) => [s.max === Infinity ? "largest pool holds more than 80% of liquidity (two or more pools)" : `largest pool holds at most ${s.max * 100}% of liquidity`, s.points] as [string, number])]} />
      <p>Only pools with ICP, ckBTC, ckETH, ckUSDC, or ckUSDT on one side count, valued from that side. Pools of two illiquid tokens priced against each other do not exist for this purpose.</p>

      <h3>Canister health</h3>
      <table>
        <thead><tr><th>State</th><th>Ledger</th><th>Index</th><th>Archive</th></tr></thead>
        <tbody>{(["healthy", "unknown", "risk", "low", "frozen", "life", "gone"] as const).map((k) => <tr><td>{k}</td><td>{h.ledger[k]}</td><td>{h.index[k]}</td><td>{h.archive[k]}</td></tr>)}</tbody>
      </table>
      <p>The lowest value across the token's canisters is used. A frozen ledger also caps the whole score at {CAP_FROZEN_LEDGER}. An uninstalled ledger is the dead-ledger floor: the grade is DEAD whatever else is true.</p>

      <h3>Upgrade and controller history</h3>
      <ul>
        <li>Controller change that left the ledger under unilateral control: {HISTORY_RULES.controllerChange.map((r) => `minus ${r.penalty} within ${r.withinDays} days`).join(", ")}.</li>
        <li>Reinstall (wipes balances) within {HISTORY_RULES.reinstall.withinDays} days: minus {HISTORY_RULES.reinstall.penalty}, whoever governs the ledger.</li>
        <li>Code deployments in the last {HISTORY_RULES.upgradeWindowDays} days under unilateral control: {HISTORY_RULES.upgradesUnilateral.map((r) => `${r.min} or more, minus ${r.penalty}`).join("; ")}.</li>
        <li>Under NNS or SNS governance every upgrade went through a proposal: {HISTORY_RULES.upgradesGoverned.map((r) => `${r.min} or more in the window, minus ${r.penalty}`).join("; ")}, otherwise no penalty.</li>
      </ul>

      <h2>Grades</h2>
      <Steps rows={GRADE_STEPS.map((g) => [`${g.grade}: ${g.tier}`, `${g.min} and above`])} />

      <h2>Insufficient data</h2>
      <p>A score is only computed when at least {Math.round(MIN_MEASURED_SHARE * 100)}% of the points possible for the token are measurable from current data. Ledger control is always required. Missing optional factors cap the score: one missing factor caps at {CAP_ONE_MISSING}, two at {CAP_TWO_MISSING}. Data older than its freshness limit counts as missing (minting account {STALE_AFTER.mint / 86400} days, holders {STALE_AFTER.holders / 86400} days, liquidity and health {STALE_AFTER.liquidity / 86400} days, history {STALE_AFTER.history / 86400} days). A token with too little data shows "Insufficient data", never a misleadingly good score, and the panel shows the range the score would land in once the missing factors are measured.</p>

      <h2>Disputes</h2>
      <p>Every factor on a token page links to its inputs: the controller list, the minting account, the excluded holders, the pools, the canister pages, the change log. If an input is wrong, the fix is to the input, not to the score: submit a label, point us at the on-chain fact, or explain what we misread through the <a href="/contact">contact form</a>. If the input is right and you disagree with the weighting, argue the weighting here in public; method changes are versioned and listed below.</p>

      <h2>Method versions</h2>
      <ul><li><strong>{METHOD_VERSION}</strong>, September 2026: initial method.</li></ul>
    </div>
  );
}
