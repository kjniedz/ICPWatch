// Failure classification for the block indexer: every error becomes one stable, machine-readable reason.
// Pure (no IO), unit tested in test/indexer-v2.test.ts.
import type { FailReason } from "./store";

/** An IC reject or transport error from a query. */
export class IcRejectError extends Error {
  constructor(public canister: string, public method: string, public code: string | null, message: string) {
    super(`${method} on ${canister} rejected${code ? ` (${code})` : ""}: ${message}`.slice(0, 400));
  }
}
/** A range the chain should have but no canister returns. */
export class BlockGapError extends Error {
  constructor(public canister: string, public at: number, detail: string) {
    super(`blocks missing at ${at} on ${canister}: ${detail}`);
  }
}
export class BlockDecodeError extends Error {}

export interface Failure {
  reason: FailReason;
  /** Nothing changes until somebody tops up, reinstalls, or restores the canister: retry once a day. */
  hopeless: boolean;
  /** The canister that failed: the ledger itself or one of its archives. */
  canister: string | null;
  /** The canister answers, but not to this block method. The caller may try the next block source. */
  noMethod: boolean;
}

const FROZEN = /out of cycles|because it's frozen|is frozen/i;
const NO_WASM = /no wasm module|contains no Wasm/i;
const GONE = /canister .*not found|does not exist/i;
const NO_METHOD = /has no query method|has no update method|method .* not found/i;
const DECODE = /cannot find required field|type mismatch|wrong magic|failed to decode|unexpected end of|is not a (map|variant)|candid|IDL error/i;

/**
 *   frozen               the ledger is out of cycles (IC0207)
 *   uninstalled          the ledger has no wasm module or is gone (IC0537, IC0301)
 *   no_get_transactions  the ledger (or its archive) runs but offers none of get_blocks, get_transactions, icrc3_get_blocks
 *   archive_gap          a block range is held by no canister: balances cannot be replayed past it
 *   archive_unreachable  an archive is frozen, uninstalled, stopped, or not answering
 *   decode_error         blocks came back in a shape this indexer cannot read
 *   other                timeouts, stopped ledgers, a reinstalled ledger, anything else
 */
export function classifyFailure(e: unknown, ledger: string): Failure {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof BlockGapError) return { reason: "archive_gap", hopeless: true, canister: e.canister, noMethod: false };
  if (e instanceof BlockDecodeError) return { reason: "decode_error", hopeless: true, canister: null, noMethod: false };
  if (e instanceof IcRejectError) {
    const archive = e.canister !== ledger;
    const frozen = e.code === "IC0207" || FROZEN.test(message);
    const noWasm = e.code === "IC0537" || NO_WASM.test(message);
    const gone = e.code === "IC0301" || GONE.test(message);
    const stopped = e.code === "IC0508" || e.code === "IC0509" || /is stopped|is stopping/i.test(message);
    if (!frozen && !noWasm && !gone && !stopped && (e.code === "IC0536" || NO_METHOD.test(message))) return { reason: "no_get_transactions", hopeless: true, canister: e.canister, noMethod: true };
    if (archive) return { reason: "archive_unreachable", hopeless: frozen || noWasm || gone, canister: e.canister, noMethod: false };
    if (frozen) return { reason: "frozen", hopeless: true, canister: e.canister, noMethod: false };
    if (noWasm || gone) return { reason: "uninstalled", hopeless: true, canister: e.canister, noMethod: false };
    if (DECODE.test(message)) return { reason: "decode_error", hopeless: true, canister: e.canister, noMethod: false };
    return { reason: "other", hopeless: false, canister: e.canister, noMethod: false };
  }
  if (DECODE.test(message)) return { reason: "decode_error", hopeless: true, canister: null, noMethod: false };
  // A tip below the cursor means the ledger was reinstalled: only a manual reset helps.
  if (/below the indexed cursor/.test(message)) return { reason: "other", hopeless: true, canister: ledger, noMethod: false };
  return { reason: "other", hopeless: false, canister: null, noMethod: false };
}
