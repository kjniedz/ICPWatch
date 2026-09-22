// Token trust score: pure, deterministic scoring. No I/O, no clock, no bindings: everything comes in through
// TrustInputs and the same inputs always give the same TrustResult. The collector (src/trust/collect.ts)
// gathers the inputs, the pages (src/pages/trust.tsx) render the result and the point tables below, so the
// public methodology page can never drift from the code.
//
// Principles:
//   * Every factor carries its state, points, a plain explanation with the numbers used, a link to the
//     evidence on ICPWatch, and the age of the data.
//   * A factor that could not be measured is "missing". It is left out of the numerator AND the denominator,
//     it widens the published band, and it caps the score. Missing never reads as good.
//   * Two required factors (ledger control, ledger liveness). Without them there is no score at all.
//   * A dead ledger is a hard floor, a frozen ledger is a hard cap.

export const METHOD_VERSION = "1.0";

export const DAY = 86400;

// ---- well-known principals --------------------------------------------------------------------------------------

export const NNS_ROOT = "r7inp-6aaaa-aaaaa-aaabq-cai";
export const NNS_GOVERNANCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";
export const MANAGEMENT_CANISTER = "aaaaa-aa";
/** Canisters with no controllers and no code path that acts on the canisters they control. They can report status, nothing else. */
export const BLACKHOLES: readonly string[] = [
  "e3mmv-5qaaa-aaaah-aadma-cai", // ninegua blackhole
  "5vdms-kaaaa-aaaap-aa3uq-cai", // CycleOps blackhole v1
  "2daxo-giaaa-aaaap-anvca-cai", // CycleOps blackhole v2
  "cpbhu-5iaaa-aaaad-aalta-cai", // CycleOps blackhole v3
];
const BLACKHOLE_SET = new Set(BLACKHOLES);

/** Textual canister ids are 27 characters and end in "-cai" (10 bytes ending 0x01 0x01). Everything else is a user principal. */
export const looksLikeCanister = (id: string): boolean => id.length === 27 && id.endsWith("-cai");

// ---- types ------------------------------------------------------------------------------------------------------

export type FactorKey = "control" | "mint" | "holders" | "liquidity" | "health" | "history";

export type ControlClass = "nns" | "blackholed" | "sns" | "canister_immutable" | "canister" | "single" | "multiple" | "unknown";
export type MinterClass = "none" | "ck_minter" | "nns_governed" | "sns_governance" | "immutable_program" | "sns_governed" | "canister" | "principal" | "unknown";

export type Grade = "A" | "B" | "C" | "D" | "E" | "DEAD" | "NA";

export interface TrustFactor {
  key: FactorKey;
  label: string;
  /** Machine state, stable across wording changes. */
  state: string;
  /** Short human form of the state. */
  stateLabel: string;
  /** Null when the factor is missing. */
  points: number | null;
  /** Points available for this token. Sub-scores that do not apply to a token kind are removed from this. */
  maxPoints: number;
  explanation: string;
  evidenceHref: string;
  /** Unix seconds of the data behind this factor, null when unknown. */
  dataAsOf: number | null;
  missing: boolean;
  /** True when a missing factor makes the whole score impossible. */
  required: boolean;
  /** The raw inputs behind the factor, each linkable: controllers, the minting account, excluded holders, canisters. */
  evidence: TrustEvidence[];
}

export interface TrustEvidence { label: string; value: string; href: string | null }

export interface TrustCap { maxScore: number; reason: string }

export interface TrustResult {
  methodVersion: string;
  /** 0 to 100. Null when insufficient. 0 for a dead ledger. */
  score: number | null;
  /** Score before caps: points earned over points measured. */
  rawScore: number | null;
  /** What the score would be if every missing factor scored zero (low) or full marks (high), before caps. */
  band: { low: number; high: number } | null;
  grade: Grade;
  tier: string;
  insufficient: boolean;
  /** Why the score is insufficient, or empty. */
  reasons: string[];
  dead: boolean;
  caps: TrustCap[];
  pointsEarned: number;
  pointsMeasured: number;
  pointsPossible: number;
  factors: TrustFactor[];
}

export interface ControlContext {
  /** Every SNS root canister we know (canisters rows with role 'root'). */
  snsRoots: ReadonlySet<string>;
  /** Controllers of other canisters, for resolving one hop: who controls the canister that controls the ledger. */
  knownControllers: ReadonlyMap<string, readonly string[]>;
}

export interface MinterContext extends ControlContext {
  /** Every SNS governance canister we know. */
  snsGovernances: ReadonlySet<string>;
  tokenKind: string;
}

export interface HolderAccount {
  account: string;
  owner: string;
  /** Whole tokens. */
  balance: number;
  /** Set when the account is left out of concentration: the reason shown to the reader ("SNS governance (treasury and staked neurons)", "DEX pool", a label name). */
  excluded: string | null;
  /** Display name from a label, when there is one. */
  name?: string | null;
  /** For an aggregate entry (all subaccounts of one owner): how many accounts it stands for. */
  accounts?: number;
}

export interface TrustInputs {
  tokenId: string;
  symbol: string;
  /** native | ck | sns | community */
  kind: string;
  /** Unix seconds. The only clock the scorer sees. */
  now: number;
  ledger: {
    /** Null when controllers were never read. */
    controllers: string[] | null;
    runStatus: string;
    health: string;
    asOf: number | null;
  } | null;
  context: MinterContext;
  minting: {
    /** ok: owner is set. none: the ledger reports no minting account. error: the read failed and nothing is cached. */
    status: "ok" | "none" | "error";
    owner: string | null;
    asOf: number | null;
    error?: string | null;
  } | null;
  holders: {
    usable: boolean;
    /** Why holder data is not usable, shown verbatim. */
    reason: string | null;
    asOf: number | null;
    /** Total supply in whole tokens. */
    supply: number | null;
    holderCount: number | null;
    /** Largest accounts, descending, with exclusions already marked. */
    top: HolderAccount[];
  } | null;
  liquidity: {
    /** Token-side depth across DEX pools in USD (market.tvl_usd). */
    tvlUsd: number | null;
    mcapUsd: number | null;
    /** USD TVL of each pool that holds this token. */
    pools: number[];
    asOf: number | null;
  } | null;
  /** Ledger, index and archive canisters of the token. */
  canisters: { id: string; role: "ledger" | "index" | "archive"; label: string; health: string; runStatus: string; asOf: number | null }[];
  history: {
    /** False when canister_info has never been read for the ledger. */
    known: boolean;
    checkedAt: number | null;
    /** Controller changes on the ledger, with the class of the controller set AFTER the change. */
    controllerChanges: { ts: number; toClass: ControlClass }[];
    /** install, reinstall and upgrade events on the ledger. */
    deployments: { ts: number; kind: "install" | "reinstall" | "upgrade" }[];
  } | null;
}

// ---- point tables (rendered verbatim on /trust-score) ----------------------------------------------------------

export const MAX_POINTS: Record<FactorKey, number> = { control: 25, mint: 15, holders: 20, liquidity: 15, health: 15, history: 10 };

export const FACTOR_LABELS: Record<FactorKey, string> = {
  control: "Ledger control", mint: "Mint authority", holders: "Holder concentration", liquidity: "Liquidity depth",
  health: "Canister health", history: "Upgrade and controller history",
};

export const CONTROL_POINTS: Record<Exclude<ControlClass, "unknown">, number> = {
  nns: 25, blackholed: 25, sns: 22, canister_immutable: 18, canister: 8, single: 6, multiple: 6,
};

export const CONTROL_LABELS: Record<ControlClass, string> = {
  nns: "NNS controlled", blackholed: "Blackholed (immutable)", sns: "SNS DAO controlled", canister_immutable: "Controlled by an immutable canister",
  canister: "Controlled by another canister", single: "Single principal", multiple: "Multiple principals", unknown: "Unknown",
};

export const MINTER_POINTS: Record<Exclude<MinterClass, "unknown">, number> = {
  none: 15, ck_minter: 15, nns_governed: 13, sns_governance: 13, immutable_program: 13, sns_governed: 12, canister: 5, principal: 0,
};

export const MINTER_LABELS: Record<MinterClass, string> = {
  none: "No one can mint", ck_minter: "Chain-key minter (mints only against deposits)", nns_governed: "NNS governed minting", sns_governance: "SNS governance (DAO proposal or protocol rewards)",
  immutable_program: "Immutable program", sns_governed: "Program controlled by an SNS DAO", canister: "Program with changeable code", principal: "A principal can mint at will", unknown: "Unknown",
};

/** Whoever controls the ledger can upgrade it to mint, so the mint factor can never score above this for a given control class. */
export const MINT_CAP_BY_CONTROL: Record<Exclude<ControlClass, "unknown">, number> = {
  nns: 15, blackholed: 15, sns: 13, canister_immutable: 13, canister: 5, single: 3, multiple: 3,
};

/** Top 10 share of free float (0 to 1) at or below `max` earns `points`. First match wins. */
export const HOLDER_STEPS: readonly { max: number; points: number }[] = [
  { max: 0.25, points: 20 }, { max: 0.4, points: 16 }, { max: 0.55, points: 12 }, { max: 0.7, points: 8 }, { max: 0.85, points: 4 }, { max: Infinity, points: 0 },
];
export const HOLDER_TOP_N = 10;

/** Token-side DEX depth in USD at or above `min` earns `points`. First match wins. */
export const DEPTH_STEPS: readonly { min: number; points: number }[] = [
  { min: 1_000_000, points: 9 }, { min: 250_000, points: 8 }, { min: 100_000, points: 7 }, { min: 25_000, points: 5 }, { min: 5_000, points: 3 }, { min: 1_000, points: 1 }, { min: -Infinity, points: 0 },
];
export const DEPTH_MAX = 9;
/** Depth over market cap. Applies to SNS and community tokens only. */
export const RATIO_STEPS: readonly { min: number; points: number }[] = [
  { min: 0.1, points: 3 }, { min: 0.02, points: 2 }, { min: 0.005, points: 1 }, { min: -Infinity, points: 0 },
];
export const RATIO_MAX = 3;
/** Share of all pool TVL that sits in the largest pool. Needs at least two pools to earn anything. */
export const SPREAD_STEPS: readonly { max: number; points: number }[] = [
  { max: 0.5, points: 3 }, { max: 0.8, points: 2 }, { max: Infinity, points: 1 },
];
export const SPREAD_MAX = 3;

type HealthKey = "healthy" | "unknown" | "risk" | "low" | "frozen" | "life" | "gone";
/** Points by role and Lifeline state. The factor takes the lowest value across all of a token's canisters. A gone ledger never reaches this table: it is the dead-ledger floor. */
export const HEALTH_POINTS: Record<"ledger" | "index" | "archive", Record<HealthKey, number>> = {
  ledger: { healthy: 15, unknown: 10, risk: 10, low: 6, frozen: 0, life: 0, gone: 0 },
  index: { healthy: 15, unknown: 12, risk: 11, low: 8, frozen: 6, life: 6, gone: 5 },
  archive: { healthy: 15, unknown: 12, risk: 10, low: 6, frozen: 3, life: 4, gone: 0 },
};

export const HISTORY_RULES = {
  /** Penalty for a controller change that left the ledger under unilateral control (single, multiple, canister), by age. */
  controllerChange: [{ withinDays: 30, penalty: 10 }, { withinDays: 90, penalty: 6 }, { withinDays: 365, penalty: 3 }] as const,
  /** A reinstall wipes ledger state (balances). Penalized for every control class. */
  reinstall: { withinDays: 365, penalty: 5 },
  /** Code deployments in the last 90 days, ledgers under unilateral control. */
  upgradesUnilateral: [{ min: 6, penalty: 6 }, { min: 3, penalty: 4 }, { min: 1, penalty: 2 }] as const,
  /** Code deployments in the last 90 days, ledgers governed by the NNS or an SNS: every one went through a proposal. */
  upgradesGoverned: [{ min: 8, penalty: 1 }] as const,
  upgradeWindowDays: 90,
};

export const GRADE_STEPS: readonly { min: number; grade: Exclude<Grade, "DEAD" | "NA">; tier: string }[] = [
  { min: 85, grade: "A", tier: "Strong" }, { min: 70, grade: "B", tier: "Good" }, { min: 55, grade: "C", tier: "Fair" }, { min: 40, grade: "D", tier: "Weak" }, { min: 0, grade: "E", tier: "Poor" },
];

/** Below this many measurable points (out of the points possible for the token) there is no score. */
export const MIN_MEASURED_SHARE = 0.6;
export const CAP_ONE_MISSING = 84;
export const CAP_TWO_MISSING = 69;
export const CAP_FROZEN_LEDGER = 25;

/** Data older than this is treated as missing, never as current. Seconds. */
export const STALE_AFTER: Record<FactorKey, number> = { control: Infinity, mint: 45 * DAY, holders: 7 * DAY, liquidity: 2 * DAY, health: 2 * DAY, history: 21 * DAY };

export const UNILATERAL: readonly ControlClass[] = ["single", "multiple", "canister"];
const isGovernedClass = (c: ControlClass) => c === "nns" || c === "sns" || c === "blackholed" || c === "canister_immutable";

// ---- classification ---------------------------------------------------------------------------------------------

type ActorKind = "nns" | "sns" | "blackhole" | "immutable" | "canister" | "principal";

function actorKind(id: string, self: string | null, ctx: ControlContext, depth: number): ActorKind {
  if (BLACKHOLE_SET.has(id)) return "blackhole";
  if (id === NNS_ROOT) return "nns";
  if (ctx.snsRoots.has(id)) return "sns";
  if (!looksLikeCanister(id)) return "principal";
  if (id === self || depth >= 1) return "canister";
  const hop = ctx.knownControllers.get(id);
  if (!hop) return "canister";
  const acting = hop.filter((p) => !BLACKHOLE_SET.has(p) && p !== id);
  if (!acting.length) return hop.includes(id) ? "canister" : "immutable";
  const kinds = acting.map((p) => actorKind(p, id, ctx, depth + 1));
  if (kinds.every((k) => k === "nns")) return "nns";
  if (kinds.every((k) => k === "nns" || k === "sns")) return "sns";
  return "canister";
}

export interface ControlVerdict {
  cls: ControlClass;
  /** Controllers that can act, blackholes removed. */
  acting: string[];
  blackholes: string[];
  /** Kind of every acting controller, same order as `acting`. */
  kinds: ActorKind[];
}

/**
 * Who controls a canister. Blackhole controllers cannot act, so they are ignored. The rest is judged by its weakest
 * member, because on the IC any single controller can upgrade alone: controllers are not a multisig.
 */
export function classifyControl(canisterId: string, controllers: readonly string[] | null | undefined, ctx: ControlContext): ControlVerdict {
  if (!controllers) return { cls: "unknown", acting: [], blackholes: [], kinds: [] };
  const blackholes = controllers.filter((p) => BLACKHOLE_SET.has(p));
  const acting = controllers.filter((p) => !BLACKHOLE_SET.has(p));
  if (!acting.length) return { cls: "blackholed", acting, blackholes, kinds: [] };
  const kinds = acting.map((p) => actorKind(p, canisterId, ctx, 0));
  const principals = kinds.filter((k) => k === "principal").length;
  const programs = kinds.filter((k) => k === "canister").length;
  let cls: ControlClass;
  if (principals) cls = principals + programs === 1 ? "single" : "multiple";
  else if (programs) cls = "canister";
  else if (kinds.includes("immutable")) cls = "canister_immutable";
  else if (kinds.includes("sns")) cls = "sns";
  else cls = "nns";
  return { cls, acting, blackholes, kinds };
}

/** Who owns the minting account, which is the only account an ICRC-1 ledger lets create tokens. */
export function classifyMinter(minting: TrustInputs["minting"], ctx: MinterContext): MinterClass {
  if (!minting || minting.status === "error") return "unknown";
  const owner = minting.owner;
  if (minting.status === "none" || !owner || owner === MANAGEMENT_CANISTER || BLACKHOLE_SET.has(owner)) return "none";
  if (owner === NNS_GOVERNANCE) return "nns_governed";
  if (ctx.snsGovernances.has(owner)) return "sns_governance";
  if (!looksLikeCanister(owner)) return "principal";
  const k = actorKind(owner, null, ctx, 0);
  // actorKind answers "who controls this canister". NNS_ROOT and SNS roots as minting owners are themselves governed.
  if (k === "nns") return ctx.tokenKind === "ck" ? "ck_minter" : "nns_governed";
  if (k === "sns") return "sns_governed";
  if (k === "immutable") return "immutable_program";
  return "canister";
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const short = (id: string) => (id.length > 30 ? `${id.slice(0, 11)}...${id.slice(-7)}` : id);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stale = (key: FactorKey, asOf: number | null, now: number) => asOf != null && now - asOf > STALE_AFTER[key];

const principalHref = (p: string) => (looksLikeCanister(p) ? `/canister/${p}` : `/account/${p}`);
const ACTOR_WORDS: Record<ActorKind, string> = {
  nns: "NNS governed", sns: "SNS governed", blackhole: "Blackhole, cannot act", immutable: "Canister without acting controllers", canister: "Canister with changeable code", principal: "Plain principal",
};

function missing(key: FactorKey, maxPoints: number, explanation: string, evidenceHref: string, dataAsOf: number | null, required = false, state = "missing", stateLabel = "Not measured"): TrustFactor {
  return { key, label: FACTOR_LABELS[key], state, stateLabel, points: null, maxPoints, explanation, evidenceHref, dataAsOf, missing: true, required, evidence: [] };
}

export function gradeFor(score: number): { grade: Grade; tier: string } {
  const g = GRADE_STEPS.find((s) => score >= s.min) ?? GRADE_STEPS[GRADE_STEPS.length - 1]!;
  return { grade: g.grade, tier: g.tier };
}

/** Order used by the screener's "minimum tier" filter. Higher is better. DEAD and NA never pass a minimum. */
export const GRADE_RANK: Record<Grade, number> = { A: 5, B: 4, C: 3, D: 2, E: 1, DEAD: 0, NA: 0 };

export function isDeadLedger(ledger: TrustInputs["ledger"]): boolean {
  return !!ledger && (ledger.health === "gone" || ledger.runStatus === "deleted" || ledger.runStatus === "no_wasm");
}
const isFrozenLedger = (ledger: TrustInputs["ledger"]) => !!ledger && (ledger.health === "frozen" || ledger.health === "life" || ledger.runStatus === "frozen" || ledger.runStatus === "out_of_cycles");

// ---- factors ----------------------------------------------------------------------------------------------------

function controlFactor(i: TrustInputs, v: ControlVerdict): TrustFactor {
  const href = `/canister/${i.tokenId}`;
  if (v.cls === "unknown") return missing("control", MAX_POINTS.control, "The controllers of the ledger canister have not been read yet. Without them nothing can be said about who can change the token's rules.", href, null, true);
  const bh = v.blackholes.length ? ` ${plural(v.blackholes.length, "blackhole controller")} ignored: a blackhole can report status but cannot act.` : "";
  const list = v.acting.map(short).join(", ");
  const text: Record<Exclude<ControlClass, "unknown">, string> = {
    nns: `Every acting controller (${list}) is the NNS root canister or a canister it controls. The ledger can only be changed by an NNS proposal.`,
    blackholed: v.blackholes.length ? "The only controllers are blackhole canisters, which cannot act. Nobody can upgrade or reinstall this ledger." : "The ledger has no controllers. Nobody can upgrade or reinstall it.",
    sns: `Every acting controller (${list}) is an SNS root canister or is controlled by one. The ledger can only be changed by a DAO proposal that token holders vote on.`,
    canister_immutable: `Controlled by ${list}, a canister that itself has no acting controllers. Its code is fixed, but what that code allows is not verified here.`,
    canister: `Controlled by ${list}. That canister's code can be changed by whoever controls it, and it can upgrade this ledger without a public vote.`,
    single: `One plain principal can upgrade this ledger alone, at any time, without notice${v.acting.length > 1 ? ` (acting controllers: ${list})` : ` (${list})`}.`,
    multiple: `${plural(v.kinds.filter((k) => k === "principal" || k === "canister").length, "controller")} can each upgrade this ledger alone (${list}). Controllers on the IC are not a multisig: any one of them is enough.`,
  };
  return {
    key: "control", label: FACTOR_LABELS.control, state: v.cls, stateLabel: CONTROL_LABELS[v.cls], points: CONTROL_POINTS[v.cls], maxPoints: MAX_POINTS.control,
    explanation: text[v.cls] + bh, evidenceHref: href, dataAsOf: i.ledger?.asOf ?? null, missing: false, required: true,
    evidence: [
      ...v.acting.map((p, n) => ({ label: ACTOR_WORDS[v.kinds[n] ?? "principal"], value: p, href: principalHref(p) })),
      ...v.blackholes.map((p) => ({ label: ACTOR_WORDS.blackhole, value: p, href: principalHref(p) })),
    ],
  };
}

function mintFactor(i: TrustInputs, control: ControlClass): TrustFactor {
  const owner = i.minting?.owner ?? null;
  const href = owner ? (looksLikeCanister(owner) ? `/canister/${owner}` : `/account/${owner}`) : `/canister/${i.tokenId}`;
  const asOf = i.minting?.asOf ?? null;
  const cls = classifyMinter(i.minting, i.context);
  if (cls === "unknown") {
    const why = i.minting?.error ? ` Last error: ${i.minting.error.slice(0, 140)}` : "";
    return missing("mint", MAX_POINTS.mint, `icrc1_minting_account could not be read from the ledger${isFrozenLedger(i.ledger) ? " because it is frozen and rejects every query" : ""}.${why}`, href, asOf);
  }
  if (stale("mint", asOf, i.now)) return missing("mint", MAX_POINTS.mint, "The last successful read of the minting account is too old to rely on.", href, asOf, false, "stale", "Stale");
  const text: Record<Exclude<MinterClass, "unknown">, string> = {
    none: owner ? `The minting account belongs to ${short(owner)}, which cannot make calls. No new tokens can be minted through the ledger's own interface.` : "The ledger reports no minting account. No new tokens can be minted through the ledger's own interface.",
    ck_minter: `The minting account belongs to ${short(owner ?? "")}, a chain-key minter controlled by the NNS. It mints only against deposits of the native asset and burns on withdrawal.`,
    nns_governed: `The minting account belongs to ${short(owner ?? "")}, which only the NNS can change. Minting follows protocol rules (for ICP: voting and node provider rewards).`,
    sns_governance: `The minting account belongs to SNS governance (${short(owner ?? "")}). New tokens appear only through an adopted DAO proposal or the voting rewards the DAO has configured.`,
    immutable_program: `The minting account belongs to ${short(owner ?? "")}, a canister with no acting controllers. It mints according to fixed code that nobody can change. What that code allows is not verified here.`,
    sns_governed: `The minting account belongs to ${short(owner ?? "")}, a canister controlled by an SNS DAO. It mints according to its code, and that code changes only by DAO proposal.`,
    canister: `The minting account belongs to ${short(owner ?? "")}, a canister whose code can be changed without a public vote${owner && !i.context.knownControllers.has(owner) ? " (its controllers have not been read yet, this is re-evaluated once they are)" : ""}. Whoever controls it decides how much is minted.`,
    principal: `The minting account belongs to a plain principal (${short(owner ?? "")}). Its holder can create any amount of new tokens with one transfer, at any time.`,
  };
  const base = MINTER_POINTS[cls];
  const cap = control === "unknown" ? MAX_POINTS.mint : MINT_CAP_BY_CONTROL[control];
  const points = Math.min(base, cap);
  const capped = points < base;
  return {
    key: "mint", label: FACTOR_LABELS.mint, state: capped ? `${cls}+controller` : cls, stateLabel: capped ? `${MINTER_LABELS[cls]}, but the ledger controller can override` : MINTER_LABELS[cls],
    points, maxPoints: MAX_POINTS.mint,
    explanation: text[cls] + (capped ? ` However, the ledger itself is ${CONTROL_LABELS[control].toLowerCase()}: whoever controls a ledger can upgrade it to mint, so this factor is limited to ${cap} of ${MAX_POINTS.mint}.` : ""),
    evidenceHref: href, dataAsOf: asOf, missing: false, required: false,
    evidence: [{ label: "icrc1_minting_account", value: owner ?? "none", href: owner ? principalHref(owner) : null }],
  };
}

export interface Concentration { topShare: number; largestShare: number; counted: number; excludedShare: number; excluded: { reason: string; share: number; accounts: number }[]; freeFloat: number; countedAccounts: HolderAccount[] }

/** Top-N share of free float: supply minus every excluded account among the largest holders. Null when it cannot be computed. */
export function concentration(top: readonly HolderAccount[], supply: number | null): Concentration | null {
  if (!supply || !(supply > 0) || !top.length) return null;
  const excludedSum = top.reduce((s, h) => s + (h.excluded ? Math.max(0, h.balance) : 0), 0);
  const freeFloat = supply - excludedSum;
  if (!(freeFloat > 0)) return null;
  const free = top.filter((h) => !h.excluded && h.balance > 0).sort((a, b) => b.balance - a.balance);
  if (!free.length) return null;
  const counted = free.slice(0, HOLDER_TOP_N);
  const byReason = new Map<string, { share: number; accounts: number }>();
  for (const h of top) {
    if (!h.excluded) continue;
    const r = byReason.get(h.excluded) ?? { share: 0, accounts: 0 };
    r.share += Math.max(0, h.balance) / supply;
    r.accounts += h.accounts ?? 1;
    byReason.set(h.excluded, r);
  }
  return {
    topShare: Math.min(1, counted.reduce((s, h) => s + h.balance, 0) / freeFloat), largestShare: Math.min(1, counted[0]!.balance / freeFloat), counted: counted.length,
    excludedShare: Math.min(1, excludedSum / supply), freeFloat, countedAccounts: counted,
    excluded: [...byReason.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.share - a.share),
  };
}

function holdersFactor(i: TrustInputs): TrustFactor {
  const href = `/token/${i.tokenId}#holders`;
  const h = i.holders;
  if (!h || !h.usable) return missing("holders", MAX_POINTS.holders, h?.reason ?? "ICPWatch has not indexed this ledger, so holder balances are not known.", href, h?.asOf ?? null);
  if (stale("holders", h.asOf, i.now)) return missing("holders", MAX_POINTS.holders, "The block index for this ledger has not advanced recently, so its balances may be out of date.", href, h.asOf, false, "stale", "Stale");
  const c = concentration(h.top, h.supply);
  if (!c) return missing("holders", MAX_POINTS.holders, h.supply ? "No freely held balances were found among the largest accounts." : "Total supply is not readable, so shares of supply cannot be computed.", href, h.asOf);
  const points = HOLDER_STEPS.find((s) => c.topShare <= s.max)!.points;
  const ex = c.excluded.length
    ? ` Left out of the calculation: ${c.excluded.slice(0, 4).map((e) => `${e.reason} (${plural(e.accounts, "account")}, ${pct(e.share)} of supply)`).join("; ")}.`
    : " No treasury, pool, minter or burn accounts were found among the largest holders, so nothing was left out.";
  return {
    key: "holders", label: FACTOR_LABELS.holders, state: points >= 16 ? "spread" : points >= 8 ? "moderate" : "concentrated",
    stateLabel: `Top ${c.counted} hold ${pct(c.topShare)} of free float`, points, maxPoints: MAX_POINTS.holders,
    explanation: `The ${c.counted} largest freely held accounts hold ${pct(c.topShare)} of the free float (the largest alone ${pct(c.largestShare)}). Free float is total supply minus excluded accounts, here ${pct(1 - c.excludedShare)} of supply.${h.holderCount != null ? ` ${h.holderCount.toLocaleString("en-US")} accounts hold a balance.` : ""}${ex}`,
    evidenceHref: href, dataAsOf: h.asOf, missing: false, required: false,
    evidence: [
      ...h.top.filter((a) => a.excluded).slice(0, 8).map((a) => ({ label: `Excluded: ${a.excluded}`, value: `${a.name ?? short(a.account)}${a.accounts && a.accounts > 1 ? ` (${a.accounts.toLocaleString("en-US")} accounts)` : ""}, ${pct(Math.max(0, a.balance) / h.supply!)} of supply`, href: `/account/${a.account}` })),
      ...c.countedAccounts.map((a, n) => ({ label: `Counted #${n + 1}`, value: `${a.name ?? short(a.account)}, ${pct(a.balance / c.freeFloat)} of free float`, href: `/account/${a.account}` })),
    ],
  };
}

function liquidityFactor(i: TrustInputs): TrustFactor {
  const href = `/token/${i.tokenId}#liquidity`;
  const l = i.liquidity;
  const ratioApplies = i.kind !== "ck" && i.kind !== "native";
  const fullMax = DEPTH_MAX + SPREAD_MAX + (ratioApplies ? RATIO_MAX : 0);
  if (!l) return missing("liquidity", fullMax, "The markets collector has not produced liquidity data yet.", href, null);
  if (stale("liquidity", l.asOf, i.now)) return missing("liquidity", fullMax, "DEX liquidity data is more than two days old.", href, l.asOf, false, "stale", "Stale");
  const tvl = Math.max(0, l.tvlUsd ?? 0);
  const pools = l.pools.filter((p) => p > 0);
  const depth = DEPTH_STEPS.find((s) => tvl >= s.min)!.points;
  const ratioKnown = ratioApplies && l.mcapUsd != null && l.mcapUsd > 0;
  const ratio = ratioKnown ? tvl / l.mcapUsd! : null;
  const ratioPts = ratio != null ? RATIO_STEPS.find((s) => ratio >= s.min)!.points : 0;
  const total = pools.reduce((s, p) => s + p, 0);
  const largest = pools.length ? Math.max(...pools) / total : null;
  const spread = pools.length >= 2 && largest != null ? SPREAD_STEPS.find((s) => largest <= s.max)!.points : 0;
  const maxPoints = DEPTH_MAX + SPREAD_MAX + (ratioKnown ? RATIO_MAX : 0);
  const parts = [
    tvl > 0 ? `${usd(tvl)} of this token's side sits in DEX pools (${depth} of ${DEPTH_MAX}).` : `No DEX liquidity was found (0 of ${DEPTH_MAX}).`,
    ratioKnown ? `That is ${pct(ratio!, ratio! < 0.01 ? 2 : 1)} of its ${usd(l.mcapUsd!)} market cap (${ratioPts} of ${RATIO_MAX}).`
      : ratioApplies ? "Market cap is unknown, so depth relative to market cap is not scored." : `Depth relative to market cap is not scored for ${i.kind === "ck" ? "chain-key tokens, which redeem 1:1 through their minter" : "ICP, which trades mostly on venues outside the IC"}.`,
    pools.length >= 2 ? `${plural(pools.length, "pool")}, the largest holds ${pct(largest!, 0)} of pooled value (${spread} of ${SPREAD_MAX}).` : pools.length === 1 ? `All of it sits in one pool (0 of ${SPREAD_MAX}).` : "",
  ].filter(Boolean);
  const points = depth + ratioPts + spread;
  return {
    key: "liquidity", label: FACTOR_LABELS.liquidity, state: tvl <= 0 ? "none" : depth >= 7 ? "deep" : depth >= 3 ? "moderate" : "thin",
    stateLabel: tvl <= 0 ? "No DEX liquidity" : `${usd(tvl)} in ${plural(pools.length, "pool")}`, points, maxPoints, explanation: parts.join(" "), evidenceHref: href, dataAsOf: l.asOf, missing: false, required: false,
    evidence: [
      { label: "Token-side DEX depth", value: usd(tvl), href },
      { label: "Market cap", value: l.mcapUsd != null && l.mcapUsd > 0 ? usd(l.mcapUsd) : "unknown", href: null },
      { label: "Pools", value: pools.length ? [...pools].sort((a, b) => b - a).slice(0, 6).map(usd).join(", ") : "none", href },
    ],
  };
}

const healthKey = (h: string): HealthKey => (["healthy", "risk", "low", "frozen", "life", "gone"].includes(h) ? (h as HealthKey) : "unknown");
const HEALTH_WORDS: Record<HealthKey, string> = { healthy: "healthy", unknown: "running, balance not readable", risk: "at risk (under 45 days of cycles)", low: "low (under 14 days of cycles)", frozen: "frozen", life: "frozen, on life support", gone: "uninstalled" };

const oldest = (ts: (number | null)[]): number | null => {
  const known = ts.filter((x): x is number => x != null);
  return known.length ? Math.min(...known) : null;
};

function healthFactor(i: TrustInputs): TrustFactor {
  const href = `/token/${i.tokenId}#health`;
  const ledger = i.canisters.find((c) => c.role === "ledger");
  if (!i.ledger || !ledger) return missing("health", MAX_POINTS.health, "Lifeline is not watching this ledger yet.", href, null, true);
  const ledgerLive = healthKey(ledger.health) !== "unknown" || (ledger.runStatus !== "unknown" && ledger.runStatus !== "");
  if (!ledgerLive) return missing("health", MAX_POINTS.health, "Lifeline has not been able to measure or probe the ledger yet, so it is not known whether it is running.", href, ledger.asOf, true);
  if (stale("health", ledger.asOf, i.now)) return missing("health", MAX_POINTS.health, "The last Lifeline reading of the ledger is more than two days old.", href, ledger.asOf, true, "stale", "Stale");
  let worst = { points: Infinity, c: ledger, key: "healthy" as HealthKey };
  for (const c of i.canisters) {
    const key = healthKey(c.health);
    const points = HEALTH_POINTS[c.role][key];
    if (points < worst.points) worst = { points, c, key };
  }
  const counts = { index: i.canisters.filter((c) => c.role === "index").length, archive: i.canisters.filter((c) => c.role === "archive").length };
  const scope = `ledger${counts.index ? ", index" : ""}${counts.archive ? ` and ${plural(counts.archive, "archive")}` : ""}`;
  const allHealthy = worst.points === MAX_POINTS.health;
  const consequence: Partial<Record<HealthKey, string>> = {
    frozen: worst.c.role === "ledger" ? " A frozen ledger rejects every call: the token cannot be transferred until someone tops it up." : worst.c.role === "archive" ? " A frozen archive still holds its blocks but is burning down toward deletion, which would lose transaction history for good." : " Wallets and explorers that rely on the index stop seeing transactions.",
    gone: worst.c.role === "archive" ? " Its share of the transaction history is permanently lost." : " It has to be reinstalled and resynced before wallets can use it again.",
    unknown: " Nobody outside its controllers can see how many cycles it has left, so no runway can be projected. Adding a blackhole controller makes it measurable.",
  };
  return {
    key: "health", label: FACTOR_LABELS.health, state: allHealthy ? "healthy" : `${worst.c.role}_${worst.key}`,
    stateLabel: allHealthy ? "All canisters healthy" : `${worst.c.role[0]!.toUpperCase()}${worst.c.role.slice(1)} ${HEALTH_WORDS[worst.key]}`, points: worst.points, maxPoints: MAX_POINTS.health,
    explanation: allHealthy ? `Lifeline watches the ${scope}. All have more than 45 days of cycles at their current burn.` : `Lifeline watches the ${scope}. The weakest is ${worst.c.label} (${short(worst.c.id)}): ${HEALTH_WORDS[worst.key]}.${consequence[worst.key] ?? ""}`,
    evidenceHref: href, dataAsOf: oldest(i.canisters.map((c) => c.asOf)), missing: false, required: true,
    evidence: i.canisters.map((c) => ({ label: c.label, value: HEALTH_WORDS[healthKey(c.health)], href: `/canister/${c.id}` })),
  };
}

function historyFactor(i: TrustInputs, control: ControlClass): TrustFactor {
  const href = `/canister/${i.tokenId}#history`;
  const h = i.history;
  if (!h || !h.known) return missing("history", MAX_POINTS.history, "The on-chain change history (canister_info) of the ledger has not been read yet.", href, h?.checkedAt ?? null);
  if (stale("history", h.checkedAt, i.now)) return missing("history", MAX_POINTS.history, "The change history of the ledger was last read more than three weeks ago.", href, h.checkedAt, false, "stale", "Stale");
  const age = (ts: number) => (i.now - ts) / DAY;
  const notes: string[] = [];
  let penalty = 0;
  const bad = h.controllerChanges.filter((c) => UNILATERAL.includes(c.toClass) && age(c.ts) >= 0).sort((a, b) => b.ts - a.ts)[0];
  if (bad) {
    const rule = HISTORY_RULES.controllerChange.find((r) => age(bad.ts) <= r.withinDays);
    if (rule) {
      penalty += rule.penalty;
      notes.push(`Controllers changed ${Math.max(0, Math.floor(age(bad.ts)))} days ago and the ledger stayed under unilateral control (minus ${rule.penalty}).`);
    }
  }
  const handovers = h.controllerChanges.filter((c) => isGovernedClass(c.toClass) && age(c.ts) <= 365).length;
  if (handovers) notes.push(`${plural(handovers, "controller change")} in the last year handed control to a DAO, the NNS or a blackhole, which is not penalized.`);
  const reinstall = h.deployments.find((d) => d.kind === "reinstall" && age(d.ts) <= HISTORY_RULES.reinstall.withinDays && age(d.ts) >= 0);
  if (reinstall) {
    penalty += HISTORY_RULES.reinstall.penalty;
    notes.push(`The ledger was reinstalled ${Math.floor(age(reinstall.ts))} days ago, which wipes its state (minus ${HISTORY_RULES.reinstall.penalty}).`);
  }
  const recent = h.deployments.filter((d) => d.kind !== "reinstall" && age(d.ts) <= HISTORY_RULES.upgradeWindowDays && age(d.ts) >= 0).length;
  const governed = isGovernedClass(control);
  const rule = (governed ? HISTORY_RULES.upgradesGoverned : HISTORY_RULES.upgradesUnilateral).find((r) => recent >= r.min);
  if (rule) {
    penalty += rule.penalty;
    notes.push(`${plural(recent, "code deployment")} in the last ${HISTORY_RULES.upgradeWindowDays} days ${governed ? "is unusually many even for a governed ledger" : "without a public vote"} (minus ${rule.penalty}).`);
  } else if (recent) notes.push(`${plural(recent, "code deployment")} in the last ${HISTORY_RULES.upgradeWindowDays} days, each through a governance proposal, which is not penalized.`);
  const points = Math.max(0, MAX_POINTS.history - penalty);
  if (!notes.length) notes.push(`No controller changes in the last year and no code deployments in the last ${HISTORY_RULES.upgradeWindowDays} days.`);
  return {
    key: "history", label: FACTOR_LABELS.history, state: penalty === 0 ? "quiet" : bad && penalty >= 6 ? "controller_change" : "active",
    stateLabel: penalty === 0 ? (recent ? `${plural(recent, "governed upgrade")} in 90 days` : "No recent changes") : bad && HISTORY_RULES.controllerChange.some((r) => age(bad.ts) <= r.withinDays) ? "Recent controller change" : `${plural(recent, "upgrade")} in 90 days`,
    points, maxPoints: MAX_POINTS.history, explanation: notes.join(" "), evidenceHref: href, dataAsOf: h.checkedAt, missing: false, required: false,
    evidence: [
      { label: `Code deployments, last ${HISTORY_RULES.upgradeWindowDays} days`, value: String(recent), href },
      { label: "Controller changes, last 365 days", value: String(h.controllerChanges.filter((c) => age(c.ts) <= 365 && age(c.ts) >= 0).length), href },
    ],
  };
}

// ---- the score --------------------------------------------------------------------------------------------------

export function scoreToken(i: TrustInputs): TrustResult {
  const verdict = classifyControl(i.tokenId, i.ledger?.controllers ?? null, i.context);
  const factors: TrustFactor[] = [
    controlFactor(i, verdict), mintFactor(i, verdict.cls), holdersFactor(i), liquidityFactor(i), healthFactor(i), historyFactor(i, verdict.cls),
  ];
  const measured = factors.filter((f) => !f.missing);
  const pointsEarned = measured.reduce((s, f) => s + (f.points ?? 0), 0);
  const pointsMeasured = measured.reduce((s, f) => s + f.maxPoints, 0);
  const pointsPossible = factors.reduce((s, f) => s + f.maxPoints, 0);
  const base = { methodVersion: METHOD_VERSION, pointsEarned, pointsMeasured, pointsPossible, factors };

  if (isDeadLedger(i.ledger)) {
    const health = factors.find((f) => f.key === "health")!;
    Object.assign(health, { state: "ledger_gone", stateLabel: "Ledger uninstalled", points: 0, missing: false, explanation: "The ledger canister has no code installed or no longer exists. Balances cannot be read and the token cannot be transferred. This overrides every other factor." });
    return { ...base, score: 0, rawScore: 0, band: { low: 0, high: 0 }, grade: "DEAD", tier: "Dead ledger", insufficient: false, reasons: [], dead: true, caps: [{ maxScore: 0, reason: "The ledger canister is uninstalled or deleted." }] };
  }

  const reasons: string[] = [];
  for (const f of factors) if (f.missing && f.required) reasons.push(`${f.label} is required and could not be measured.`);
  if (pointsMeasured < pointsPossible * MIN_MEASURED_SHARE) reasons.push(`Only ${pointsMeasured} of ${pointsPossible} points could be measured. At least ${Math.round(MIN_MEASURED_SHARE * 100)}% is needed for a score.`);
  if (reasons.length) return { ...base, score: null, rawScore: null, band: null, grade: "NA", tier: "Insufficient data", insufficient: true, reasons, dead: false, caps: [] };

  const rawScore = Math.round((100 * pointsEarned) / pointsMeasured);
  const band = { low: Math.round((100 * pointsEarned) / pointsPossible), high: Math.round((100 * (pointsEarned + (pointsPossible - pointsMeasured))) / pointsPossible) };
  const caps: TrustCap[] = [];
  const miss = factors.filter((f) => f.missing).map((f) => f.label.toLowerCase());
  if (miss.length === 1) caps.push({ maxScore: CAP_ONE_MISSING, reason: `${miss[0]![0]!.toUpperCase()}${miss[0]!.slice(1)} is not measured. Grade A needs every factor.` });
  if (miss.length >= 2) caps.push({ maxScore: CAP_TWO_MISSING, reason: `${miss.length} factors are not measured (${miss.join(", ")}).` });
  if (isFrozenLedger(i.ledger)) caps.push({ maxScore: CAP_FROZEN_LEDGER, reason: "The ledger is frozen: the token cannot be transferred until the canister is topped up." });
  const score = Math.min(rawScore, ...caps.map((c) => c.maxScore));
  return { ...base, score, rawScore, band, ...gradeFor(score), insufficient: false, reasons: [], dead: false, caps: caps.filter((c) => c.maxScore < rawScore) };
}
