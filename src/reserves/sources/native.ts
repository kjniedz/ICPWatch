// Native chain readings, all THIRD PARTY: public explorers and RPC nodes we do not run. Two independent
// sources per chain, compared by the reconciler; disagreement is surfaced, never averaged away.
//
// Why not the IC's own Bitcoin API or EVM RPC canister: both charge cycles and accept calls from
// canisters only, so a Worker cannot use them. Verified 2026-09-21 against their candid.

export interface AddressBalance { address: string; value: bigint | null; error?: string }

// ---- Bitcoin ------------------------------------------------------------------------------------------------

export interface BtcSource { name: string; url: string; balance(address: string): Promise<bigint>; tip(): Promise<number | null> }

const esploraSource = (name: string, base: string): BtcSource => ({
  name,
  url: base,
  async balance(address) {
    const r = await fetch(`${base}/api/address/${address}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    const j = (await r.json()) as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number } };
    return BigInt(j.chain_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum);
  },
  async tip() {
    const r = await fetch(`${base}/api/blocks/tip/height`);
    return r.ok ? Number(await r.text()) : null;
  },
});

export const BTC_SOURCES: BtcSource[] = [esploraSource("mempool.space", "https://mempool.space"), esploraSource("blockstream.info", "https://blockstream.info")];

/** Confirmed balance of a set of addresses from one source, with bounded concurrency. Missing addresses are reported, not skipped. */
export async function btcBalances(src: BtcSource, addresses: string[], concurrency = 4): Promise<AddressBalance[]> {
  const out: AddressBalance[] = new Array(addresses.length);
  let i = 0;
  const worker = async () => {
    while (i < addresses.length) {
      const k = i++;
      const address = addresses[k]!;
      try {
        out[k] = { address, value: await src.balance(address) };
      } catch (e) {
        out[k] = { address, value: null, error: String(e).slice(0, 120) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
  return out;
}

// ---- Ethereum -------------------------------------------------------------------------------------------------

export interface EthSource { name: string; url: string }
export const ETH_SOURCES: EthSource[] = [
  { name: "publicnode", url: "https://ethereum-rpc.publicnode.com" },
  { name: "llamarpc", url: "https://eth.llamarpc.com" },
  { name: "cloudflare-eth", url: "https://cloudflare-eth.com" },
];

async function rpc<T>(src: EthSource, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(src.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error(`${src.name} ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${src.name}: ${j.error.message}`);
  return j.result as T;
}

const hexToBig = (h: string) => BigInt(h === "0x" ? "0x0" : h);

export async function ethBlockNumber(src: EthSource): Promise<number> {
  return Number(hexToBig(await rpc<string>(src, "eth_blockNumber", [])));
}

/** ETH balance in wei at a block (hex or "latest"). */
export async function ethBalance(src: EthSource, address: string, block: string | number = "latest"): Promise<bigint> {
  return hexToBig(await rpc<string>(src, "eth_getBalance", [address, typeof block === "number" ? `0x${block.toString(16)}` : block]));
}

/** ERC-20 balanceOf(holder) at a block. Selector 0x70a08231, address left-padded to 32 bytes. */
export async function erc20Balance(src: EthSource, contract: string, holder: string, block: string | number = "latest"): Promise<bigint> {
  const data = `0x70a08231${holder.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  return hexToBig(await rpc<string>(src, "eth_call", [{ to: contract, data }, typeof block === "number" ? `0x${block.toString(16)}` : block]));
}
