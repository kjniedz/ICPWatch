// Flow-pattern heuristics for exchange detection. PURE: no network, no bindings, no clock.
// They run on a generic transfer row, so the same code works on the ICRC block index (transfers_big today)
// and on the ICP ledger index once it exists. Thresholds and their reasoning: docs/LABELS.md.
//
// What these can and cannot say: a pattern match means "this account behaves like a custodial hot wallet"
// or "like a deposit address". It never says WHICH exchange. So matches are filed in the review queue, and
// only an overwhelming match is published, as an unnamed, visibly "inferred" label.

export interface FlowTransfer {
  /** Sender and receiver in whatever id form the ledger uses (ICRC-1 text or account identifier). Null for mint and burn. */
  from: string | null;
  to: string | null;
  /** Whole tokens. */
  amount: number;
  /** Unix seconds. */
  ts: number;
}

export interface FlowStats {
  account: string;
  inCount: number; outCount: number;
  /** Distinct senders to, and distinct receivers from, this account. */
  inCounterparties: number; outCounterparties: number;
  inVolume: number; outVolume: number;
  /** Where most of the outflow went, by volume. */
  topDestination: string | null;
  /** Share of outflow volume and of outgoing transfers that went to topDestination, 0 to 1. */
  topDestinationVolumeShare: number; topDestinationCountShare: number;
  firstTs: number; lastTs: number;
}

interface Acc { s: FlowStats; senders: Set<string>; receivers: Map<string, { n: number; v: number }> }

/** One pass over the rows. Self transfers and rows without both sides (mint, burn) are ignored. */
export function flowStats(rows: Iterable<FlowTransfer>): Map<string, FlowStats> {
  const acc = new Map<string, Acc>();
  const get = (account: string, ts: number): Acc => {
    let a = acc.get(account);
    if (!a) {
      a = { s: { account, inCount: 0, outCount: 0, inCounterparties: 0, outCounterparties: 0, inVolume: 0, outVolume: 0, topDestination: null, topDestinationVolumeShare: 0, topDestinationCountShare: 0, firstTs: ts, lastTs: ts }, senders: new Set(), receivers: new Map() };
      acc.set(account, a);
    }
    if (ts < a.s.firstTs) a.s.firstTs = ts;
    if (ts > a.s.lastTs) a.s.lastTs = ts;
    return a;
  };
  for (const r of rows) {
    if (!r.from || !r.to || r.from === r.to || !(r.amount > 0)) continue;
    const from = get(r.from, r.ts), to = get(r.to, r.ts);
    from.s.outCount++; from.s.outVolume += r.amount;
    const rec = from.receivers.get(r.to) ?? { n: 0, v: 0 };
    rec.n++; rec.v += r.amount;
    from.receivers.set(r.to, rec);
    to.s.inCount++; to.s.inVolume += r.amount;
    to.senders.add(r.from);
  }
  const out = new Map<string, FlowStats>();
  for (const [k, a] of acc) {
    a.s.inCounterparties = a.senders.size;
    a.s.outCounterparties = a.receivers.size;
    let top: string | null = null, topV = -1, topN = 0;
    for (const [dest, r] of a.receivers) if (r.v > topV) { top = dest; topV = r.v; topN = r.n; }
    a.s.topDestination = top;
    a.s.topDestinationVolumeShare = a.s.outVolume > 0 && top ? topV / a.s.outVolume : 0;
    a.s.topDestinationCountShare = a.s.outCount > 0 && top ? topN / a.s.outCount : 0;
    out.set(k, a.s);
  }
  return out;
}

export interface FlowThresholds {
  /** Hot wallet: at least this many distinct senders AND this many distinct receivers. */
  hotMinInCounterparties: number; hotMinOutCounterparties: number;
  /** Hot wallet: min(in, out) / max(in, out) by volume. A custodial wallet passes value through; a sink or a faucet does not. */
  hotMinVolumeBalance: number;
  /** Hot wallet: active over at least this many days, so a one day airdrop does not qualify. */
  hotMinActiveDays: number;
  /** Deposit address: receives from at least this many distinct senders ... */
  depositMinInCounterparties: number;
  /** ... sends at least this many times ... */
  depositMinOutCount: number;
  /** ... at least this share of its outflow (volume and count) goes to one hot wallet ... */
  depositMinSweepShare: number;
  /** ... and it keeps almost nothing: outflow / inflow by volume. */
  depositMinPassThrough: number;
  /** Published without review only above all three of these. */
  overwhelmingCounterparties: number; overwhelmingDepositAddresses: number; overwhelmingActiveDays: number;
}

export const DEFAULT_THRESHOLDS: FlowThresholds = {
  hotMinInCounterparties: 50, hotMinOutCounterparties: 50, hotMinVolumeBalance: 0.5, hotMinActiveDays: 14,
  depositMinInCounterparties: 3, depositMinOutCount: 2, depositMinSweepShare: 0.95, depositMinPassThrough: 0.9,
  overwhelmingCounterparties: 1000, overwhelmingDepositAddresses: 25, overwhelmingActiveDays: 90,
};

export interface FlowContext {
  /** Accounts that must never be reported: already labeled, canister owned (a dapp, not a custodian), and so on. */
  exclude?: (account: string) => boolean;
  thresholds?: Partial<FlowThresholds>;
}

export const volumeBalance = (s: FlowStats): number => {
  const hi = Math.max(s.inVolume, s.outVolume);
  return hi > 0 ? Math.min(s.inVolume, s.outVolume) / hi : 0;
};
const activeDays = (s: FlowStats): number => (s.lastTs - s.firstTs) / 86400;

/** Hot wallet pattern: very many counterparties on both sides, value passes through, sustained over time. */
export function isHotWallet(s: FlowStats, t: FlowThresholds = DEFAULT_THRESHOLDS): boolean {
  return s.inCounterparties >= t.hotMinInCounterparties && s.outCounterparties >= t.hotMinOutCounterparties && volumeBalance(s) >= t.hotMinVolumeBalance && activeDays(s) >= t.hotMinActiveDays;
}

/** Deposit address pattern: receives from many, keeps nothing, and sweeps to a single destination that is a hot wallet. */
export function isDepositAddress(s: FlowStats, hotWallets: ReadonlySet<string>, t: FlowThresholds = DEFAULT_THRESHOLDS): boolean {
  if (!s.topDestination || !hotWallets.has(s.topDestination) || hotWallets.has(s.account)) return false;
  return s.inCounterparties >= t.depositMinInCounterparties && s.outCount >= t.depositMinOutCount
    && s.topDestinationVolumeShare >= t.depositMinSweepShare && s.topDestinationCountShare >= t.depositMinSweepShare
    && s.inVolume > 0 && s.outVolume / s.inVolume >= t.depositMinPassThrough;
}

export interface HotWalletCandidate {
  account: string; stats: FlowStats;
  /** Accounts matching the deposit pattern that sweep into this wallet. */
  depositAddresses: string[];
  /** True only above every "overwhelming" threshold. Everything else needs a human. */
  overwhelming: boolean;
  reasons: string[];
}

export interface FlowFindings { hotWallets: HotWalletCandidate[]; accountsSeen: number }

/** The whole analysis for one ledger's rows: hot wallets first, then the deposit addresses that feed them. */
export function analyzeFlows(rows: Iterable<FlowTransfer>, ctx: FlowContext = {}): FlowFindings {
  const t: FlowThresholds = { ...DEFAULT_THRESHOLDS, ...ctx.thresholds };
  const stats = flowStats(rows);
  const excluded = ctx.exclude ?? (() => false);
  const hot = new Map<string, HotWalletCandidate>();
  for (const s of stats.values()) {
    if (!isHotWallet(s, t) || excluded(s.account)) continue;
    hot.set(s.account, { account: s.account, stats: s, depositAddresses: [], overwhelming: false, reasons: [] });
  }
  const hotSet = new Set(hot.keys());
  for (const s of stats.values()) {
    if (excluded(s.account) || !isDepositAddress(s, hotSet, t)) continue;
    hot.get(s.topDestination!)!.depositAddresses.push(s.account);
  }
  for (const c of hot.values()) {
    const s = c.stats;
    c.reasons = [
      `${s.inCounterparties} distinct senders and ${s.outCounterparties} distinct receivers`,
      `inflow ${s.inVolume.toFixed(2)} and outflow ${s.outVolume.toFixed(2)} (balance ${volumeBalance(s).toFixed(2)})`,
      `active for ${Math.round(activeDays(s))} days`,
      `${c.depositAddresses.length} accounts match the deposit address pattern and sweep into it`,
    ];
    c.overwhelming = s.inCounterparties >= t.overwhelmingCounterparties && s.outCounterparties >= t.overwhelmingCounterparties
      && c.depositAddresses.length >= t.overwhelmingDepositAddresses && activeDays(s) >= t.overwhelmingActiveDays;
  }
  return { hotWallets: [...hot.values()].sort((a, b) => b.stats.inCounterparties + b.stats.outCounterparties - (a.stats.inCounterparties + a.stats.outCounterparties)), accountsSeen: stats.size };
}
