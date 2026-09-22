// Pure reconciliation math for ck reserves. No I/O, fully unit tested (test/reserves.test.ts).
//
// Reserves and supply never match to the satoshi at an instant:
//   - a withdrawal burns tokens on the IC first, the native payout follows minutes to hours later;
//   - a deposit lands on the native chain first, the mint follows after confirmations;
//   - minters keep fees in native funds that back no token.
// So two ratios are published. The raw ratio is simply reserves / supply. The reconciled ratio
// removes what is already owed to someone else (withdrawals in flight, deposits not minted yet)
// before dividing, and is the one that must not fall below 1.
import type { ReserveStatus, Trust } from "./types";

const SCALE = 10n ** 12n;

/** a / b as a double, exact to 12 decimal places, safe for wei-sized integers. */
export function ratio(a: bigint, b: bigint): number | null {
  if (b <= 0n) return null;
  return Number((a * SCALE) / b) / 1e12;
}

/** Base units to a decimal string, trailing zeros trimmed. */
export function unitsToString(v: bigint, decimals: number, maxFrac = decimals): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = decimals ? (abs % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFrac)) : "";
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

/** Base units to a double in whole tokens. For charts and ordering only, never for accounting. */
export function unitsToNumber(v: bigint | null | undefined, decimals: number): number | null {
  if (v == null) return null;
  const base = 10n ** BigInt(decimals);
  return Number(v / base) + Number(v % base) / Number(base);
}

/** "0.00140463" with 8 decimals to 140463n. Null when the text is not a plain decimal. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const s = text.trim().replace(/[_,\s]/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export interface NativeInput { source: string; value: bigint | null; complete: boolean }

export interface ReconcileInput {
  symbol: string;
  decimals: number;
  /** icrc1_total_supply of the ck ledger. */
  supply: bigint | null;
  /** The minter's own accounting of native funds. */
  minterReserves: bigint | null;
  native: NativeInput[];
  pendingOut: bigint | null;
  pendingIn: bigint | null;
  fees: bigint | null;
  /** How far below the minter's figure an honest native reading may be (payouts sent but not final, unconfirmed change). */
  nativeSlack: bigint;
  /** Allowed shortfall as a fraction of supply, from `toleranceFor`. */
  tolerance: number;
  /** Two native readings count as agreeing when they differ by at most this. Default 0: pinned to the same block they must be equal. */
  nativeAgreeEps?: bigint;
}

export interface Component {
  key: "supply" | "minter_reserves" | "native_reserves" | "pending_out" | "pending_in" | "net_reserves" | "excess" | "fees" | "unexplained";
  label: string;
  /** Base units as a string (JSON safe). Null when unknown. */
  amount: string | null;
  /** How the line enters the net: +1 adds, -1 subtracts, 0 is informational. */
  sign: 1 | -1 | 0;
  trust: Trust;
  note: string;
}

export type NativeAgreement = "agree" | "differ" | "single" | "none";
export type NativeCheck = "confirms" | "short" | "unavailable";

export interface Reconciliation {
  rawRatio: number | null;
  reconciledRatio: number | null;
  components: Component[];
  tolerance: number;
  status: ReserveStatus;
  explanation: string;
  /** Which figure the raw ratio used. */
  reservesBasis: "native" | "minter" | null;
  reservesUsed: bigint | null;
  netReserves: bigint | null;
  excess: bigint | null;
  unexplained: bigint | null;
  nativeAgreement: NativeAgreement;
  nativeConsensus: bigint | null;
  nativeCheck: NativeCheck;
  /** True when the native chain, read by us through third parties, confirms the minter's figure. */
  verified: boolean;
  /** True when a term of the reconciliation could not be read and was treated as zero. */
  partial: boolean;
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const pct = (r: number) => `${(r * 100).toFixed(r >= 0.9995 && r < 1.9995 ? 3 : 2)}%`;

/**
 * Majority value among complete native readings. Two readings that agree beat a third that does
 * not. When no two agree the smallest one is used, which is the conservative choice.
 */
export function nativeConsensus(native: NativeInput[], eps = 0n): { agreement: NativeAgreement; value: bigint | null } {
  const vals = native.filter((n) => n.complete && n.value != null).map((n) => n.value!);
  if (!vals.length) return { agreement: "none", value: null };
  if (vals.length === 1) return { agreement: "single", value: vals[0]! };
  let best: { value: bigint; votes: number } | null = null;
  for (const v of vals) {
    const votes = vals.filter((o) => abs(o - v) <= eps).length;
    if (!best || votes > best.votes || (votes === best.votes && v < best.value)) best = { value: v, votes };
  }
  if (best!.votes >= 2) return { agreement: "agree", value: best!.value };
  return { agreement: "differ", value: vals.reduce((a, b) => (b < a ? b : a)) };
}

export function reconcile(i: ReconcileInput): Reconciliation {
  const tol = i.tolerance;
  const cons = nativeConsensus(i.native, i.nativeAgreeEps ?? 0n);
  const u = (v: bigint | null) => (v == null ? "unknown" : `${unitsToString(v, i.decimals, 8)}`);
  const components: Component[] = [];
  const base = {
    tolerance: tol, nativeAgreement: cons.agreement, nativeConsensus: cons.value, components,
  };

  components.push({ key: "supply", label: `${i.symbol} supply on the IC`, amount: i.supply?.toString() ?? null, sign: 0, trust: "first-party", note: "icrc1_total_supply of the ledger canister" });
  components.push({ key: "minter_reserves", label: "Reserves, minter's own accounting", amount: i.minterReserves?.toString() ?? null, sign: 1, trust: "first-party", note: "reported by the minter canister, which holds the threshold key" });
  if (cons.value != null) components.push({ key: "native_reserves", label: "Reserves seen on the native chain", amount: cons.value.toString(), sign: 0, trust: "third-party", note: cons.agreement === "agree" ? "two independent sources agree" : cons.agreement === "single" ? "one source only" : "sources disagree, smallest value shown" });

  const reservesBasis: Reconciliation["reservesBasis"] = cons.value != null && cons.agreement !== "differ" ? "native" : i.minterReserves != null ? "minter" : cons.value != null ? "native" : null;
  const reservesUsed = reservesBasis === "native" ? cons.value : reservesBasis === "minter" ? i.minterReserves : null;

  if (i.supply == null || reservesUsed == null) {
    return {
      ...base, rawRatio: null, reconciledRatio: null, status: "unknown", reservesBasis, reservesUsed, netReserves: null, excess: null, unexplained: null,
      nativeCheck: "unavailable", verified: false, partial: true,
      explanation: i.supply == null ? "The ledger's supply could not be read, so nothing can be said right now." : "No reserve figure could be read from the minter or the native chain right now.",
    };
  }

  // Reconcile on the minter's snapshot when there is one: its reserves, pending withdrawals and fees
  // come from the same canister state, so they are consistent with each other. The native chain is
  // then used to check that snapshot instead of being mixed into it.
  const ledgerSide = i.minterReserves ?? cons.value!;
  const partial = i.pendingOut == null;
  const out = i.pendingOut ?? 0n;
  const inn = i.pendingIn ?? 0n;
  const net = ledgerSide - out - inn;
  components.push({ key: "pending_out", label: "Withdrawals in flight", amount: i.pendingOut?.toString() ?? null, sign: -1, trust: "first-party", note: "already burned on the IC, native payout not sent or not final yet: these funds belong to the withdrawers" });
  components.push({ key: "pending_in", label: "Deposits awaiting mint", amount: i.pendingIn?.toString() ?? null, sign: -1, trust: "first-party", note: i.pendingIn == null ? "not exposed by this minter, treated as zero (this can only understate the backing)" : "seen by the minter on the native chain, tokens not minted yet" });
  components.push({ key: "net_reserves", label: "Net reserves backing the supply", amount: net.toString(), sign: 0, trust: "derived", note: "reserves minus withdrawals in flight minus deposits awaiting mint" });

  const excess = net - i.supply;
  const unexplained = i.fees != null ? excess - i.fees : null;
  components.push({ key: "excess", label: excess >= 0n ? "Surplus over supply" : "Shortfall against supply", amount: excess.toString(), sign: 0, trust: "derived", note: "net reserves minus supply" });
  components.push({ key: "fees", label: "Fees held by the minter", amount: i.fees?.toString() ?? null, sign: 0, trust: "first-party", note: i.fees == null ? "this minter does not publish a fee total: its surplus is accumulated fees, which we cannot itemize" : "native funds kept by the minter that back no token" });
  if (unexplained != null) components.push({ key: "unexplained", label: "Surplus not explained by fees", amount: unexplained.toString(), sign: 0, trust: "derived", note: "direct transfers to the reserve address, rounding, and gas accounting end up here" });

  if (i.supply === 0n) {
    return {
      ...base, rawRatio: null, reconciledRatio: null, status: net >= 0n ? "backed" : "deviation", reservesBasis, reservesUsed, netReserves: net, excess, unexplained,
      nativeCheck: "unavailable", verified: false, partial,
      explanation: "No tokens are outstanding, so there is nothing to back.",
    };
  }

  const rawRatio = ratio(reservesUsed, i.supply);
  const reconciledRatio = ratio(net, i.supply);
  const tolAbs = (i.supply * BigInt(Math.round(tol * 1e9))) / 1_000_000_000n;

  let nativeCheck: NativeCheck = "unavailable";
  if (cons.value != null && i.minterReserves != null) nativeCheck = cons.value + i.nativeSlack + tolAbs >= i.minterReserves ? "confirms" : "short";
  // Without a minter figure the native reading is the ledger side itself, so it is its own check.
  const verified = nativeCheck === "confirms" || (i.minterReserves == null && cons.agreement === "agree");

  let status: ReserveStatus;
  const r = reconciledRatio ?? 0;
  if (nativeCheck === "short") status = "deviation";
  else if (r >= 1) status = "backed";
  else if (r >= 1 - tol) status = "within_tolerance";
  else status = "deviation";

  const parts: string[] = [];
  if (status === "backed") parts.push(`Every ${i.symbol} is backed: net reserves are ${pct(r)} of supply after setting aside ${u(out)} owed to withdrawals in flight.`);
  else if (status === "within_tolerance") parts.push(`Net reserves are ${pct(r)} of supply, ${u(-excess)} short, inside the ${(tol * 100).toFixed(2)}% band that normal timing between the ledger and the minter produces.`);
  else if (nativeCheck === "short") parts.push(`The native chain shows ${u(cons.value)} while the minter accounts for ${u(i.minterReserves)}, a gap larger than the ${u(i.nativeSlack)} that payouts in flight can explain.`);
  else parts.push(`Net reserves are ${pct(r)} of supply, ${u(-excess)} short, outside the ${(tol * 100).toFixed(2)}% tolerance.`);
  if (excess > 0n) parts.push(i.fees != null ? `The surplus of ${u(excess)} is mostly fees the minter holds (${u(i.fees)}).` : `The surplus of ${u(excess)} is fees the minter has accumulated.`);
  if (nativeCheck === "confirms") parts.push(cons.agreement === "agree" ? "Two independent native-chain sources confirm the minter's figure." : cons.agreement === "single" ? "One native-chain source confirms the minter's figure, a second was not reachable." : "Native sources disagree with each other, the smaller one still confirms the minter's figure.");
  else if (nativeCheck === "unavailable") parts.push("No complete native-chain reading is available right now, so this rests on the minter's own accounting.");
  if (partial) parts.push("Withdrawals in flight could not be read and were treated as zero.");

  return { ...base, rawRatio, reconciledRatio, status, explanation: parts.join(" "), reservesBasis, reservesUsed, netReserves: net, excess, unexplained, nativeCheck, verified, partial };
}

// ---- tolerance ----------------------------------------------------------------------------------------

/** Hard ceiling: no amount of observed noise may widen the band beyond one percent of supply. */
export const TOLERANCE_CEILING = 0.01;

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

/**
 * Per-asset shortfall tolerance as a fraction of supply.
 *
 * The only honest reason for net reserves to dip under supply is timing: the ledger and the minter
 * are read a moment apart, and a mint or burn can land between the two reads. The size of that
 * effect is the size of normal run-to-run movement in (net reserves - supply), so the band is three
 * times the 95th percentile of that movement over the asset's own recent history, never below the
 * asset's floor and never above TOLERANCE_CEILING.
 *
 * `excessSeries` is (net reserves - supply) / supply per run, oldest first.
 */
export function toleranceFor(floor: number, excessSeries: number[]): number {
  const deltas: number[] = [];
  for (let k = 1; k < excessSeries.length; k++) deltas.push(Math.abs(excessSeries[k]! - excessSeries[k - 1]!));
  if (deltas.length < 24) return floor; // under four hours of history: floor only
  const p95 = percentile(deltas, 0.95) ?? 0;
  return Math.min(TOLERANCE_CEILING, Math.max(floor, 3 * p95));
}
