export const DataSources = () => (
  <div class="wrap page narrow prose">
    <h1>Data sources</h1>
    <p class="lede">Every number on ICPWatch has a known source and a timestamp. On-chain reads come first. Where a third-party source is used it sits behind an adapter, is labeled as such, and is listed here.</p>

    <h2>Lifeline</h2>
    <table>
      <thead><tr><th>Source</th><th>Covers</th><th>Confidence</th><th>Cadence</th></tr></thead>
      <tbody>
        <tr><td>SNS root <code>get_sns_canisters_summary</code> (certified update call)</td><td>Every canister of every SNS: root, governance, ledger, index, swap, archives, dapps. Cycles, idle burn, freezing threshold, memory, controllers, module hash.</td><td>Measured</td><td>Hourly</td></tr>
        <tr><td>NNS root <code>canister_status</code> (certified update call)</td><td>Everything NNS root controls: ICP ledger, index, and archives, all ck token suites, and community ledgers that added NNS root as a controller.</td><td>Measured</td><td>Hourly</td></tr>
        <tr><td>Canister <code>/metrics</code> via <code>http_request</code> query</td><td>Self-reported cycle balance of DFINITY ledger, index, and archive canisters.</td><td>Measured</td><td>10 minutes</td></tr>
        <tr><td>Blackhole <code>canister_status</code></td><td>Canisters that list the public ninegua blackhole as a controller. It does not return idle burn. CycleOps blackholes refuse outside callers, so they are not a source.</td><td>Measured</td><td>Hourly</td></tr>
        <tr><td>Query probe to a known method</td><td>Liveness of ledgers, indexes, and archives. A frozen canister answers with IC0207.</td><td>Probed</td><td>Hourly</td></tr>
        <tr><td>Update-call probe to a method that does not exist</td><td>Liveness of any canister at all. The ingress filter answers before method lookup: frozen IC0207, stopped IC0508, missing IC0301. Costs the target one ingress fee, about a millionth of a trillion cycles.</td><td>Probed</td><td>Hourly</td></tr>
        <tr><td><code>read_state</code> (certified)</td><td>Controllers, module hash, subnet for any canister.</td><td>Measured</td><td>On discovery</td></tr>
        <tr><td>Ledger <code>icrc3_get_archives</code> and <code>archives</code></td><td>Archive discovery for every ledger.</td><td>Measured</td><td>Hourly</td></tr>
      </tbody>
    </table>
    <p>One thing worth knowing: a controller can report a canister as <code>running</code> while it is frozen, because freezing is a function of balance and threshold, not of run status. Lifeline derives frozen state from the balance and from probes, never from that field alone.</p>
    <p>Balance queries skip per-node signature verification to stay inside our CPU budget. Controller status reads are update calls and are verified against the NNS root key.</p>

    <h2>Markets</h2>
    <table>
      <thead><tr><th>Source</th><th>Covers</th><th>Kind</th></tr></thead>
      <tbody>
        <tr><td>ICPSwap ICP/ckUSDC pool <code>metadata</code></td><td>ICP price in USD from <code>sqrtPriceX96</code>, assuming ckUSDC is one dollar. Cross-checked against the REST price every run.</td><td>On-chain</td></tr>
        <tr><td>Ledger <code>icrc1_total_supply</code>, <code>icrc1_fee</code>, <code>icrc1_decimals</code></td><td>Supply and token parameters, per ledger.</td><td>On-chain</td></tr>
        <tr><td>SNS aggregator canister, SNS-W, ck ledger suite orchestrator</td><td>Token registry: every SNS, every ck token, with their canister ids.</td><td>On-chain</td></tr>
        <tr><td>ICPSwap info API</td><td>Pools, reserves, 24h and 7d volume, hourly and daily candles. ICPSwap's own on-chain info canisters are stopped, so this REST feed is the only source for volume.</td><td>Third party</td></tr>
        <tr><td>ICRC ledger API (DFINITY)</td><td>Top holders and the large-transfer feed. No canister can enumerate holders, so the only alternative is replaying every block, which is planned.</td><td>Third party</td></tr>
      </tbody>
    </table>
    <p><strong>DEX coverage.</strong> As verified in September 2026, ICPSwap is the only ICP DEX with meaningful volume. KongSwap has removed every pool and its API is offline, Sonic has not traded since early August, and ICDex trades about a dollar a day. The aggregation layer takes any number of DEX adapters, so new venues slot in when they have liquidity worth counting.</p>
    <p><strong>TVL.</strong> A pool only counts if one side is ICP, ckBTC, ckETH, ckUSDC, or ckUSDT, and it is valued from that side. Pools of two illiquid tokens priced against each other inflate naive TVL sums into the billions.</p>

    <h2>Network</h2>
    <table>
      <thead><tr><th>Source</th><th>Covers</th><th>Kind</th></tr></thead>
      <tbody>
        <tr><td>NNS governance <code>list_proposals</code></td><td>Proposals, tallies, deadlines, outcomes.</td><td>On-chain</td></tr>
        <tr><td>IC public API (DFINITY)</td><td>Block rate, message rate, cycle burn rate, per-subnet metrics, canister counts. These rates have no on-chain source.</td><td>Third party</td></tr>
      </tbody>
    </table>
    <p><strong>Per-canister burn is private.</strong> Nobody can rank every canister on a subnet by burn: balances are visible only to controllers. Subnet pages therefore rank the canisters Lifeline can measure, and say so.</p>
  </div>
);
