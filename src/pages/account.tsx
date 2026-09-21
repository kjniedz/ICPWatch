// Account page: one ICP account identifier, principal, or ICRC-1 account, read live.
import type { AccountTx, AccountView, TxPage } from "../collectors/accounts";
import { shortAccount } from "../lib/account";
import { fmtNum, fmtUsd, isoDate, ago } from "../lib/format";
import { CopyId, Crumbs, Empty, Fresh, TokenLogo } from "../ui/components";

/** Token amounts without padded zeros: 0.2498, 16,004, 1.4998. */
const amountText = (n: number | null) => (n == null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1 ? 8 : Math.abs(n) < 1000 ? 4 : 2 }));

const KIND: Record<AccountTx["kind"], string> = { transfer: "Transfer", mint: "Mint", burn: "Burn", approve: "Approve" };

function Direction({ tx }: { tx: AccountTx }) {
  if (tx.kind === "approve") return <span class="chip">approve</span>;
  if (tx.direction === "in") return <span class="pill ok">{tx.kind === "mint" ? "mint" : "in"}</span>;
  if (tx.direction === "out") return <span class="pill risk">{tx.kind === "burn" ? "burn" : "out"}</span>;
  if (tx.direction === "self") return <span class="pill unk">self</span>;
  return <span class="pill unk">{KIND[tx.kind].toLowerCase()}</span>;
}

/** Transactions table. `pageHref` builds the link to the next (older) page from the `next_start` cursor. */
export function TxTable({ page, pageHref }: { page: TxPage; pageHref: (start: string) => string }) {
  if (page.error && !page.txs.length) return <div class="card"><Empty>Transactions could not be read right now ({page.error}).</Empty></div>;
  if (!page.txs.length) return <div class="card"><Empty>No {page.symbol} transactions found for this account.</Empty></div>;
  return (
    <div class="card tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Block</th><th>Direction</th><th>Counterparty</th><th class="r">Amount</th><th class="r">Fee</th><th class="r">Time</th></tr></thead>
        <tbody>
          {page.txs.map((tx) => (
            <tr>
              <td class="num muted">{tx.id}</td>
              <td><Direction tx={tx} /></td>
              <td class="mono" style="font-size:12px">
                {tx.counterparty ? (
                  <a href={`/account/${tx.counterparty}`} title={tx.counterparty}>{tx.counterparty_label ?? shortAccount(tx.counterparty)}</a>
                ) : <span class="muted">{tx.kind === "mint" ? "minting account" : tx.kind === "burn" ? "burned" : "n/a"}</span>}
              </td>
              <td class={`r num strong ${tx.direction === "in" ? "up" : tx.direction === "out" ? "down" : ""}`}>
                {tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : ""}{amountText(tx.amount)} {page.symbol}
              </td>
              <td class="r num muted">{tx.fee != null ? amountText(tx.fee) : ""}</td>
              <td class="r muted">{tx.ts ? <time datetime={isoDate(tx.ts)} data-ago={tx.ts}>{ago(tx.ts)}</time> : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {page.next_start ? <div class="card-pad" style="text-align:center"><a class="btn btn-ghost btn-sm" href={pageHref(page.next_start)} rel="nofollow">Older transactions</a></div> : null}
    </div>
  );
}

export function AccountPage({ a }: { a: AccountView }) {
  const self = `/account/${a.icrc_account ?? a.account_id}`;
  const title = a.canister ? a.canister.label : a.kind === "account_id" ? "ICP account" : a.is_canister ? "Canister account" : a.kind === "icrc_account" ? "ICRC-1 account" : "Principal";
  return (
    <div class="wrap page">
      <Crumbs items={[["Network", "/network"], ["Account", null]]} />
      <div class="detail-head">
        <div style="min-width:0">
          <h1>{title} {a.is_canister ? <span class="chip">canister</span> : null}</h1>
          {a.principal ? (
            <div class="mono muted" style="font-size:12.5px;margin-top:4px;word-break:break-all">{a.icrc_account ?? a.principal} <CopyId id={a.icrc_account ?? a.principal} /></div>
          ) : null}
          <div class="mono muted" style="font-size:12px;margin-top:4px;word-break:break-all">
            <span style="font-family:inherit">{a.principal ? "ICP account " : ""}</span>{a.account_id} <CopyId id={a.account_id} />
          </div>
        </div>
        <div class="px">
          <div class="v">{a.total_usd != null ? fmtUsd(a.total_usd) : "n/a"}</div>
          <div class="muted" style="font-size:12px">{a.holdings ? "ICP plus tracked tokens" : "ICP only"}</div>
        </div>
      </div>

      {a.canister ? (
        <div class="callout" style="margin-bottom:16px">
          This is the {a.principal ? "" : "default ICP account of the "}watched canister <a class="link" href={`/canister/${a.canister.id}`}>{a.canister.label}</a>
          {a.canister.token_id ? <> in the <a class="link" href={`/token/${a.canister.token_id}`}>token group</a></> : null}.
        </div>
      ) : a.is_canister && a.principal ? (
        <div class="callout" style="margin-bottom:16px">This principal is a canister. <a class="link" href={`/canister/${a.principal}`}>Look up its health, controllers, and upgrade history</a>.</div>
      ) : null}

      <div class="card kv">
        <div>
          <div class="k">ICP balance</div>
          <div class="v">{a.icp.balance != null ? `${amountText(a.icp.balance)} ICP` : "unknown"}</div>
          <div class="s">{a.icp.error ? `could not be read: ${a.icp.error}` : a.icp.usd != null ? `${fmtUsd(a.icp.usd)} at ${fmtUsd(a.icp.price_usd)} per ICP` : "no ICP price yet"}</div>
        </div>
        <div>
          <div class="k">Tokens held</div>
          <div class="v">{a.holdings ? fmtNum(a.holdings.length) : "n/a"}</div>
          <div class="s">{a.holdings ? `${a.holdings_checked} tracked ledgers asked` : "needs a principal"}</div>
        </div>
        <div>
          <div class="k">Token value</div>
          <div class="v">{a.holdings ? fmtUsd(a.holdings.reduce((s, h) => s + (h.usd ?? 0), 0)) : "n/a"}</div>
          <div class="s">{a.subaccount ? "this subaccount only" : a.principal ? "default subaccount only" : ""}</div>
        </div>
        <div>
          <div class="k">Neurons</div>
          <div class="v">private</div>
          <div class="s">not readable by anyone but the owner</div>
        </div>
      </div>
      <div style="margin-top:8px"><Fresh ts={a.icp.fetched_at} source={a.icp.source} staleAfter={120} label="read" /></div>

      <div class="sec-head"><h2>Token holdings</h2>{a.holdings ? <Fresh ts={a.fetched_at} source={`${a.holdings_source} (${a.holdings_checked} ledgers)`} staleAfter={120} label="read" /> : null}</div>
      {a.holdings ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Token</th><th class="r">Balance</th><th class="r">Price</th><th class="r">Value</th><th class="r">History</th></tr></thead>
            <tbody>
              {a.holdings.map((h) => (
                <tr>
                  <td><a class="name" href={`/token/${h.token_id}`}><TokenLogo id={h.token_id} symbol={h.symbol} logo={h.logo} /><span><span class="t">{h.name}</span><span class="sub">{h.symbol}</span></span></a></td>
                  <td class="r num">{amountText(h.balance)}</td>
                  <td class="r num muted">{fmtUsd(h.price_usd)}</td>
                  <td class="r num strong">{fmtUsd(h.usd)}</td>
                  <td class="r">{h.has_index ? <a class="link" href={`${self}?token=${h.token_id}#token-txs`} rel="nofollow">transactions</a> : <span class="muted">no index</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.holdings.length ? null : <Empty>No balances found on the tracked ledgers for this account.</Empty>}
        </div>
      ) : (
        <div class="card"><Empty>An account identifier is a one-way hash of a principal and a subaccount, so other ledgers cannot be asked about it. Search for the principal instead to see its token holdings.</Empty></div>
      )}

      {a.token_txs ? (
        <>
          <div class="sec-head" id="token-txs"><h2>{a.token_txs.symbol} transactions</h2><Fresh ts={a.token_txs.fetched_at} source={a.token_txs.source} staleAfter={120} label="read" /></div>
          <TxTable page={a.token_txs} pageHref={(s) => `${self}?token=${a.token_txs!.token_id}&tstart=${s}#token-txs`} />
        </>
      ) : null}

      <div class="sec-head" id="icp-txs"><h2>ICP transactions</h2><Fresh ts={a.icp_txs.fetched_at} source={a.icp_txs.source} staleAfter={120} label="read" /></div>
      <TxTable page={a.icp_txs} pageHref={(s) => `${self}?start=${s}#icp-txs`} />

      <p class="note" style="margin-top:12px">
        Read live from the ledgers and their index canisters when this page loads. Nothing is connected or signed, and ICPWatch does not store account lookups.
        Staked ICP and SNS neurons are private on the Internet Computer: only their owner can list them, so they are not part of any total here.
        {a.principal && !a.subaccount ? " Balances are for the default subaccount. Funds held in other subaccounts (for example exchange deposit accounts) have their own account pages." : ""}
      </p>
    </div>
  );
}

export function AccountNotFound({ id }: { id: string }) {
  const hex = /^[0-9a-f]{64}$/i.test(id.trim());
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Network", "/network"], ["Account", null]]} />
      <div class="page-head"><div><h1>Not an account</h1></div></div>
      <div class="callout warn">
        {hex
          ? "That is 64 hex characters, but its first four bytes are not the CRC32 checksum of the rest, so it is not an ICP account identifier. It may be a transaction hash or contain a typo."
          : "That is not an ICP account identifier (64 hex characters), a principal, or an ICRC-1 account."}
      </div>
      <form class="bigsearch" action="/search" method="get" role="search" style="margin-top:20px;max-width:none">
        <input type="search" name="q" value={id} placeholder="Account identifier or principal" autocomplete="off" spellcheck={false} aria-label="Search" />
      </form>
    </div>
  );
}
