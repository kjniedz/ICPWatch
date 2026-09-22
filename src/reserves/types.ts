// Shared types for the ck reserves dashboard. Amounts are bigint base units (satoshi, wei, token
// base units) everywhere in memory and TEXT in the database, because wei does not fit a double.
import type { Env } from "../env";

export type Chain = "bitcoin" | "ethereum" | (string & {});

/**
 * Who stands behind a number.
 *   first-party: read from an NNS-controlled canister on the IC by query (ledger, minter).
 *   third-party: a public explorer or RPC node on the native chain. Never trusted alone.
 *   derived:     computed by us from public inputs (for example an address derived from the IC's
 *                threshold key), reproducible by anyone.
 */
export type Trust = "first-party" | "third-party" | "derived";

export interface Provenance {
  /** Human readable, shown in the UI next to the number. */
  source: string;
  trust: Trust;
  /** Unix seconds when we read it. */
  ts: number;
  ok: boolean;
  error?: string;
  /** Where a visitor can look at the same thing. */
  url?: string;
}

export interface SupplyReading { supply: bigint; prov: Provenance }

export interface NativeAddress {
  address: string;
  role: "main" | "deposit" | "minter" | "sweeper" | "helper-contract" | "token-contract";
  label: string;
  /** Explorer link for a human. */
  url: string;
  /** True when we re-derived this address from the IC threshold public key and the minter's canister id. */
  derived?: boolean;
}

/** What the minter canister itself reports, in one snapshot where possible. */
export interface MinterView {
  /** Native funds the minter accounts for as its own, base units. */
  reserves: bigint | null;
  /** Burned on the IC, native funds still inside `reserves` (withdrawals not yet paid out or not yet final). Null when unreadable. */
  pendingOut: bigint | null;
  pendingOutCount: number | null;
  /** Deposits the minter has seen on the native chain but not minted yet. Null when the minter does not expose it. */
  pendingIn: bigint | null;
  /** Fees the minter holds in native funds that back no token (known only for some minters). */
  fees: bigint | null;
  /**
   * How far below `reserves` an honest native reading may legitimately be: funds that already left on
   * the native chain while the minter still counts them (sent but not final), unconfirmed change, etc.
   */
  nativeSlack: bigint;
  addresses: NativeAddress[];
  /** Free-form facts worth showing: block heights, counts, minimums. */
  extra: Record<string, string | number | null>;
  prov: Provenance;
}

/** One independent look at the native chain. */
export interface NativeReading {
  source: string;
  value: bigint | null;
  /** False when this reading covers only part of the reserves (for example a rolling address sweep that is not finished). */
  complete: boolean;
  /** Share of the reserve addresses covered, 0..1. */
  coverage: number;
  blockHeight: number | null;
  ts: number;
  url?: string;
  error?: string;
}

export interface FlowCounters { minted: bigint; burned: bigint; prov: Provenance }

export interface RunContext {
  env: Env;
  host: string;
  now: number;
  /** Per-run memo so adapters that share a minter or an RPC batch make the call once. */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Everything the collector needs to know about one ck asset. Adding an asset means writing one of
 * these (or, for ckERC20s, nothing at all: the registry builds them from the ckETH minter).
 */
export interface AssetAdapter {
  /** Stable key, also the URL slug: "ckBTC". */
  id: string;
  symbol: string;
  chain: Chain;
  /** What backs it: "BTC", "ETH", "USDC (ERC-20)". */
  nativeAsset: string;
  decimals: number;
  ledgerId: string;
  minterId: string;
  /** ERC-20 contract or similar, when there is one. */
  contract?: string | null;
  /** Shortfall tolerance floor as a fraction of supply. See docs/RESERVES.md. */
  toleranceFloor: number;
  readSupply(ctx: RunContext): Promise<SupplyReading>;
  readMinterView(ctx: RunContext): Promise<MinterView>;
  /** Independent native-chain readings, third party, ideally two. */
  readNative(ctx: RunContext, view: MinterView | null): Promise<NativeReading[]>;
  /** Cumulative mint and burn counters when the minter exposes trustworthy ones. Optional: the collector falls back to supply deltas. */
  flows?(ctx: RunContext): Promise<FlowCounters | null>;
}

export type ReserveStatus = "backed" | "within_tolerance" | "deviation" | "unknown";
