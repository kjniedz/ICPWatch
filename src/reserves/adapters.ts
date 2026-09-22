// Asset adapters: one per Chain Fusion asset. ckBTC and ckETH are written out; every ckERC20 is built
// from the ckETH minter's own token list, so a new ckERC20 needs no code. A future UTXO-chain asset
// (ckLTC) is a copy of the ckBTC adapter with its own minter, explorer base URLs, and hrp.
import { ledgerSupply, newMeter } from "../indexer/ledger";
import { BTC_SOURCES, ETH_SOURCES, btcBalances, erc20Balance, ethBalance, ethBlockNumber } from "./sources/native";
import { CKBTC_LEDGER, CKBTC_MINTER, CKETH_LEDGER, CKETH_MINTER, canisterHttpGet, ckethInfo, parseCkbtcDashboard, parseCkbtcMetrics, parseCkethDashboard, type CkethInfo } from "./sources/minters";
import type { AssetAdapter, MinterView, NativeReading, RunContext, SupplyReading } from "./types";

const supplyOf = (ledgerId: string, decimals: number): AssetAdapter["readSupply"] => async (ctx) => {
  const ts = ctx.now;
  try {
    const supply = await ledgerSupply(ctx.host, ledgerId, newMeter());
    return { supply, prov: { source: `${ledgerId} icrc1_total_supply`, trust: "first-party", ts, ok: true, url: `https://dashboard.internetcomputer.org/canister/${ledgerId}` } };
  } catch (e) {
    return { supply: 0n, prov: { source: `${ledgerId} icrc1_total_supply`, trust: "first-party", ts, ok: false, error: String(e).slice(0, 160) } };
  }
  void decimals;
};

/** How many of the minter's deposit addresses to spot-check on the native chain per run (plus the main address). */
const BTC_SAMPLE = 24;

export const ckBTC: AssetAdapter = {
  id: "ckBTC", symbol: "ckBTC", chain: "bitcoin", nativeAsset: "BTC", decimals: 8, ledgerId: CKBTC_LEDGER, minterId: CKBTC_MINTER, contract: null,
  toleranceFloor: 0.001,
  readSupply: supplyOf(CKBTC_LEDGER, 8),
  async readMinterView(ctx) {
    const [dashHtml, metricsText] = await Promise.all([
      ctx.memo("ckbtc:dashboard", () => canisterHttpGet(ctx.host, CKBTC_MINTER, "/dashboard")),
      ctx.memo("ckbtc:metrics", () => canisterHttpGet(ctx.host, CKBTC_MINTER, "/metrics")),
    ]);
    const d = parseCkbtcDashboard(dashHtml);
    const m = parseCkbtcMetrics(metricsText);
    const reserves = d.managed ?? m.btcBalance;
    const addresses = [...d.accounts.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
    return {
      reserves, pendingOut: d.pending, pendingOutCount: d.pendingCount, pendingIn: null, fees: null,
      // Inputs of submitted-but-unconfirmed withdrawal transactions plus unconfirmed change may not show as confirmed balance yet.
      nativeSlack: (d.submitted ?? 0n) + (d.unconfirmedChange ?? 0n),
      addresses: [
        ...(d.mainAddress ? [{ address: d.mainAddress, role: "main" as const, label: "Main address (change and consolidation)", url: `https://mempool.space/address/${d.mainAddress}` }] : []),
        ...addresses.slice(0, BTC_SAMPLE).map(([address]) => ({ address, role: "deposit" as const, label: "Depositor address (threshold ECDSA)", url: `https://mempool.space/address/${address}` })),
      ],
      extra: {
        managed_addresses: m.managedAddresses, utxos_available: m.utxosAvailable, submitted_txs: d.submittedCount, submitted_sats: d.submitted != null ? d.submitted.toString() : null,
        unconfirmed_change_sats: d.unconfirmedChange != null ? d.unconfirmedChange.toString() : null, min_confirmations: d.minConfirmations ?? m.minConfirmations, quarantined_sats: d.quarantined?.toString() ?? null,
        known_utxo_total_sats: d.totalKnownUtxos?.toString() ?? null, addresses_in_table: d.accounts.size,
      },
      prov: { source: "ckBTC minter /dashboard and /metrics (NNS-controlled canister, its own UTXO accounting)", trust: "first-party", ts: ctx.now, ok: reserves != null, url: `https://${CKBTC_MINTER}.raw.icp0.io/dashboard` },
    };
  },
  async readNative(ctx, view) {
    if (!view) return [];
    const addrs = view.addresses.map((a) => a.address);
    if (!addrs.length) return [];
    // The minter manages thousands of addresses; the dashboard lists a page of them. We confirm the main
    // address plus a sample, from two explorers, and report the share of the reserve that was covered.
    const known = new Map<string, bigint>();
    const total = view.reserves ?? 0n;
    return Promise.all(BTC_SOURCES.map(async (src) => {
      try {
        const [tip, bals] = await Promise.all([src.tip().catch(() => null), btcBalances(src, addrs, 4)]);
        let sum = 0n;
        let ok = 0;
        for (const b of bals) if (b.value != null) { sum += b.value; ok++; known.set(b.address, b.value); }
        const coverage = total > 0n ? Math.min(1, Number(sum) / Number(total)) : 0;
        return { source: src.name, value: ok ? sum : null, complete: false, coverage, blockHeight: tip, ts: ctx.now, url: src.url, error: ok < bals.length ? `${bals.length - ok} of ${bals.length} addresses failed` : undefined } satisfies NativeReading;
      } catch (e) {
        return { source: src.name, value: null, complete: false, coverage: 0, blockHeight: null, ts: ctx.now, url: src.url, error: String(e).slice(0, 120) };
      }
    }));
  },
};

/** ckETH minter facts, read once per run and shared by ckETH and every ckERC20. */
const ckethShared = (ctx: RunContext) => ctx.memo("cketh:info", () => ckethInfo(ctx.host));
const ckethDash = (ctx: RunContext) => ctx.memo("cketh:dashboard", async () => parseCkethDashboard(await canisterHttpGet(ctx.host, CKETH_MINTER, "/dashboard")));
/** One block number per run so every Ethereum reading is pinned to the same height across sources. */
const ethPinnedBlock = (ctx: RunContext) => ctx.memo("eth:block", async () => {
  for (const s of ETH_SOURCES) {
    try { return (await ethBlockNumber(s)) - 3; } catch { /* next */ }
  }
  return null;
});

function ethView(info: CkethInfo, symbol: string, reserves: bigint | null, fees: bigint | null, dash: Awaited<ReturnType<typeof ckethDash>>, ctx: RunContext, contract: string | null): MinterView {
  const po = dash.pendingOut.get(symbol);
  const pi = dash.pendingIn.get(symbol);
  const addresses: MinterView["addresses"] = [];
  if (info.minterAddress) addresses.push({ address: info.minterAddress, role: "minter", label: "Minter address (threshold ECDSA)", url: `https://etherscan.io/address/${info.minterAddress}` });
  if (info.ethHelper && symbol === "ckETH") addresses.push({ address: info.ethHelper, role: "helper-contract", label: "ETH deposit helper contract", url: `https://etherscan.io/address/${info.ethHelper}` });
  if (info.erc20Helper && symbol !== "ckETH") addresses.push({ address: info.erc20Helper, role: "helper-contract", label: "ERC-20 deposit helper contract", url: `https://etherscan.io/address/${info.erc20Helper}` });
  if (contract) addresses.push({ address: contract, role: "token-contract", label: `${symbol.slice(2)} token contract`, url: `https://etherscan.io/token/${contract}` });
  return {
    reserves, pendingOut: dash.ok ? (po?.amount ?? 0n) : null, pendingOutCount: dash.ok ? (po?.count ?? 0) : null, pendingIn: pi?.amount ?? 0n, fees,
    // A withdrawal the minter still lists as pending may already have left the address on chain (sent, awaiting finality).
    nativeSlack: dash.ok ? (po?.amount ?? 0n) : 0n, addresses,
    extra: { last_observed_block: info.lastObservedBlock, last_eth_scraped_block: info.lastEthScraped, last_erc20_scraped_block: info.lastErc20Scraped, pending_in_count: pi?.count ?? 0 },
    prov: { source: "ckETH minter get_minter_info and /dashboard (NNS-controlled canister)", trust: "first-party", ts: ctx.now, ok: reserves != null, url: `https://${CKETH_MINTER}.raw.icp0.io/dashboard` },
  };
}

async function ethNative(ctx: RunContext, minter: string, contract: string | null): Promise<NativeReading[]> {
  const block = await ethPinnedBlock(ctx);
  return Promise.all(ETH_SOURCES.slice(0, 2).map(async (src) => {
    try {
      const value = contract ? await erc20Balance(src, contract, minter, block ?? "latest") : await ethBalance(src, minter, block ?? "latest");
      return { source: src.name, value, complete: true, coverage: 1, blockHeight: block, ts: ctx.now, url: src.url } satisfies NativeReading;
    } catch (e) {
      return { source: src.name, value: null, complete: true, coverage: 0, blockHeight: block, ts: ctx.now, url: src.url, error: String(e).slice(0, 120) };
    }
  }));
}

export const ckETH: AssetAdapter = {
  id: "ckETH", symbol: "ckETH", chain: "ethereum", nativeAsset: "ETH", decimals: 18, ledgerId: CKETH_LEDGER, minterId: CKETH_MINTER, contract: null,
  toleranceFloor: 0.001,
  readSupply: supplyOf(CKETH_LEDGER, 18),
  async readMinterView(ctx) {
    const [info, dash] = await Promise.all([ckethShared(ctx), ckethDash(ctx)]);
    // eth_balance already excludes fees the minter charged; unspent fees sit in the same address on chain.
    return ethView(info, "ckETH", info.ethBalance, dash.unspentTxFees, dash, ctx, null);
  },
  async readNative(ctx) {
    const info = await ckethShared(ctx);
    return info.minterAddress ? ethNative(ctx, info.minterAddress, null) : [];
  },
};

export function ckErc20(symbol: string, contract: string, ledgerId: string, decimals: number): AssetAdapter {
  const lc = contract.toLowerCase();
  return {
    id: symbol, symbol, chain: "ethereum", nativeAsset: `${symbol.slice(2)} (ERC-20)`, decimals, ledgerId, minterId: CKETH_MINTER, contract,
    toleranceFloor: 0.001,
    readSupply: supplyOf(ledgerId, decimals),
    async readMinterView(ctx) {
      const [info, dash] = await Promise.all([ckethShared(ctx), ckethDash(ctx)]);
      return ethView(info, symbol, info.erc20Balances.get(lc) ?? null, null, dash, ctx, contract);
    },
    async readNative(ctx) {
      const info = await ckethShared(ctx);
      return info.minterAddress ? ethNative(ctx, info.minterAddress, contract) : [];
    },
  };
}

/** Every asset: the two written adapters plus one ckERC20 adapter per token the ckETH minter supports. */
export async function assetRegistry(ctx: RunContext, decimalsOf: (ledgerId: string) => number | undefined): Promise<AssetAdapter[]> {
  const out: AssetAdapter[] = [ckBTC, ckETH];
  try {
    const info = await ckethShared(ctx);
    for (const t of info.tokens) out.push(ckErc20(t.symbol, t.contract, t.ledgerId, decimalsOf(t.ledgerId) ?? (t.symbol.includes("USD") ? 6 : 18)));
  } catch {
    /* ckETH minter unreachable: ckERC20s are skipped this run and reported as unknown */
  }
  return out;
}

export type { SupplyReading };
