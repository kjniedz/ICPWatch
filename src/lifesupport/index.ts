// Life support (phase 4): capped, budgeted, audited top-ups that keep a canister frozen but alive.
// See docs/LIFE_SUPPORT.md. The funded path is OFF unless every condition of liveGate() holds.
export * from "./planner";
export * from "./engine";
export { createFunder, fetchXdrRate, fundingPrincipal, identityFromSecret, parseSeed, topUpMemo, topUpSubaccount, TPUP_MEMO, type Funder, type NotifyOutcome, type TransferOutcome, type XdrRate } from "./funding";
