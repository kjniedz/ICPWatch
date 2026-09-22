// /markets/smart-money: wallets whose large DEX trades worked out, and what they are buying now.
import type { Position, SmartFlowRow, SmartWalletRow } from "../smartmoney";
import { ago, fmtCompact, fmtNum } from "../lib/format";
import type { EntityLabel } from "../labels";
import { Crumbs, Empty, Fresh, TokenLogo } from "../ui/components";
import { EntityName } from "./labels";

const money = (v: number) => <span class={`num ${v > 0 ? "up" : v < 0 ? "down" : ""}`}>{v >= 0 ? "+" : "-"}{fmtCompact(Math.abs(v), "$")}</span>;

export function SmartMoneyPage({ wallets, flows, labels }: { wallets: SmartWalletRow[]; flows: SmartFlowRow[]; labels: Map<string, EntityLabel> }) {
  const updated = wallets[0]?.updated_at ?? null;
  return (
    <div class="wrap page" style="max-width:1200px">
      <Crumbs items={[["Markets", "/markets"], ["Smart money", null]]} />
      <div class="page-head">
        <div>
          <h1>Smart money</h1>
          <p class="lede">Wallets ranked by how their large DEX trades turned out over the last 90 days, from ICPWatch's own ledger index: buys are pool-to-wallet, sells wallet-to-pool, each priced at our hourly candle. Unrealized gains use the wallet's real current balance. Exchanges, treasuries, pools, and minters are excluded.</p>
        </div>
        <div class="page-actions"><Fresh ts={updated} source="ICPWatch block index + DEX pool labels + own price history" staleAfter={2 * 86400} label="ranked" /></div>
      </div>

      <div class="sec-head"><h2>What the top 50 are buying</h2><span class="note">net flow, last 7 days</span></div>
      {flows.length ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Token</th><th class="r">Bought</th><th class="r">Sold</th><th class="r">Net</th><th class="r hide-m">Wallets</th></tr></thead>
            <tbody>
              {flows.slice(0, 15).map((f) => (
                <tr>
                  <td><a class="name" href={`/token/${f.token_id}`}><TokenLogo id={f.token_id} symbol={f.symbol} logo={f.logo} /><span><span class="t">{f.symbol}</span><span class="sub">{f.name}</span></span></a></td>
                  <td class="r num">{fmtCompact(f.buy_usd, "$")}</td>
                  <td class="r num">{fmtCompact(f.sell_usd, "$")}</td>
                  <td class="r">{money(f.buy_usd - f.sell_usd)}</td>
                  <td class="r num hide-m">{fmtNum(f.wallets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>No trades by top wallets in the last week.</Empty></div>}

      <div class="sec-head"><h2>Leaderboard</h2><span class="note">{fmtNum(wallets.length)} wallets, at least $1,000 deployed</span></div>
      {wallets.length ? (
        <div class="card tbl-wrap">
          <table class="tbl" data-sortable>
            <thead><tr><th style="width:36px">#</th><th>Wallet</th><th class="r" data-sort="num" aria-sort="descending">P&amp;L</th><th class="r hide-m" data-sort="num">Realized</th><th class="r hide-m" data-sort="num">Unrealized</th><th class="r" data-sort="num">Deployed</th><th class="r hide-m" data-sort="num">Return</th><th class="r hide-m" data-sort="num" title="Closed positions won / lost">W / L</th><th>Best positions</th><th class="r hide-m">Last trade</th></tr></thead>
            <tbody>
              {wallets.map((w, i) => {
                let tokens: Position[] = [];
                try { tokens = JSON.parse(w.tokens) as Position[]; } catch { tokens = []; }
                const pnl = w.realized_usd + w.unrealized_usd;
                return (
                  <tr>
                    <td class="muted">{i + 1}</td>
                    <td><EntityName id={w.owner} label={labels.get(w.owner)} short /></td>
                    <td class="r" data-v={pnl}>{money(pnl)}</td>
                    <td class="r hide-m" data-v={w.realized_usd}>{money(w.realized_usd)}</td>
                    <td class="r hide-m" data-v={w.unrealized_usd}>{money(w.unrealized_usd)}</td>
                    <td class="r num" data-v={w.invested_usd}>{fmtCompact(w.invested_usd, "$")}</td>
                    <td class="r num hide-m" data-v={pnl / w.invested_usd}>{((pnl / w.invested_usd) * 100).toFixed(0)}%</td>
                    <td class="r num hide-m" data-v={w.wins - w.losses}>{w.wins} / {w.losses}</td>
                    <td>{tokens.slice(0, 3).map((p) => <a class="chip" href={`/token/${p.token_id}`} title={`${p.closed ? "closed" : "open"}: bought ${fmtCompact(p.bought_usd, "$")}, ${p.pnl_usd >= 0 ? "+" : ""}${fmtCompact(p.pnl_usd, "$")}`}>{p.symbol} {p.pnl_usd >= 0 ? "+" : "-"}{fmtCompact(Math.abs(p.pnl_usd), "$")}</a>)}</td>
                    <td class="r hide-m">{w.last_trade ? ago(w.last_trade) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>The ranking runs nightly once the index has enough trade history.</Empty></div>}
      <div class="src" style="margin-top:10px">Only movements large enough for our index to keep (roughly $5,000 and up at the time) count, so this is the behaviour of size, not of everyone. A wallet's cost basis starts at the first buy we saw; sells of tokens it acquired before that are ignored rather than guessed. Rank = return, damped for wallets with fewer than four positions, scaled by log of capital deployed.</div>
    </div>
  );
}
