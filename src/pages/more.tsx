import type { WhaleTransfer } from "../collectors/ledgerApi";
import type { Kv, PoolRow, TokenMarketRow, TokenRow } from "../db/queries";
import { ago, fmtCompact, fmtNum, fmtUsd, isoDate, shortDate } from "../lib/format";
import { Conf, CopyId, Crumbs, Empty, Fresh, HealthPill, TokenLogo } from "../ui/components";
import { PoolsTable, TokenTable } from "./markets";
import type { CanisterHistory } from "../collectors/history";
import { HistoryTimeline } from "./history";
import type { EntityLabel } from "../labels";
import { EntityName } from "./labels";

export function PoolsPage({ pools, fetchedAt }: { pools: PoolRow[]; fetchedAt: number | null }) {
  return (
    <div class="wrap page">
      <Crumbs items={[["Markets", "/markets"], ["Pools", null]]} />
      <div class="page-head">
        <div><h1>Pools</h1><p class="lede">Every pool with a real asset on at least one side, ranked by 24h volume. Pools priced only against each other are excluded, since their TVL is routinely fake.</p></div>
        <Fresh ts={fetchedAt} source="DEX adapters" staleAfter={900} />
      </div>
      <div class="filters" style="margin-bottom:12px"><input class="input" type="search" placeholder="Filter pools" data-filter-for="pools" aria-label="Filter pools" /></div>
      <PoolsTable pools={pools} />
    </div>
  );
}

export function NewListingsPage({ tokens, since }: { tokens: TokenRow[]; since: number | null }) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Markets", "/markets"], ["New listings", null]]} />
      <div class="page-head"><div><h1>New listings</h1><p class="lede">Tokens as they enter the registry: new SNS launches from SNS-W, new ck tokens from the orchestrator, and DEX tokens once real liquidity backs them.</p></div></div>
      {since ? <p class="note" style="margin-bottom:14px">ICPWatch started tracking on {shortDate(since)}. Everything that already existed was listed that day, so this feed gets meaningful from then on.</p> : null}
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Token</th><th>Type</th><th>Listed</th><th class="hide-m">Discovered via</th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr>
                <td><a class="name" href={`/token/${t.id}`}><TokenLogo id={t.id} symbol={t.symbol} logo={t.logo} /><span><span class="t">{t.name}</span><span class="sub">{t.symbol}</span></span></a></td>
                <td>{t.kind === "sns" ? "SNS" : t.kind === "ck" ? "Chain-key" : t.kind === "native" ? "Native" : "Community"}</td>
                <td><time datetime={isoDate(t.listed_at)} data-ago={t.listed_at}>{ago(t.listed_at)}</time></td>
                <td class="hide-m muted">{t.listed_via}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tokens.length ? null : <Empty>Nothing listed yet.</Empty>}
      </div>
    </div>
  );
}

const shortAcct = (a: string) => (a.length > 30 ? `${a.slice(0, 14)}...${a.slice(-6)}` : a);

export function WhalesPage({ feed, labels }: { feed: Kv<WhaleTransfer[]> | null; labels?: Map<string, EntityLabel> }) {
  const rows = feed?.value ?? [];
  return (
    <div class="wrap page">
      <Crumbs items={[["Markets", "/markets"], ["Whale alerts", null]]} />
      <div class="page-head">
        <div><h1>Whale alerts</h1><p class="lede">The largest transfers of the last 24 hours across the most liquid tokens, valued at the current aggregated price.</p></div>
        <Fresh ts={feed?.fetched_at} source={feed?.source ?? "ledger API"} staleAfter={5400} />
      </div>
      <div class="card tbl-wrap">
        <table class="tbl" id="whales" data-sortable>
          <thead><tr><th data-sort="text">Token</th><th class="r" data-sort="num">Amount</th><th class="r" data-sort="num" aria-sort="descending">Value</th><th>From</th><th>To</th><th data-sort="num">When</th></tr></thead>
          <tbody>
            {rows.map((w) => (
              <tr>
                <td data-v={w.symbol}><a href={`/token/${w.token_id}`} style="font-weight:600">{w.symbol}</a> <span class="muted" style="font-size:11px">#{w.index}</span></td>
                <td class="r num" data-v={w.amount}>{fmtCompact(w.amount)}</td>
                <td class="r num strong" data-v={w.usd}>{fmtCompact(w.usd, "$")}</td>
                <td><EntityName id={w.from} label={labels?.get(w.from)} short /></td>
                <td><EntityName id={w.to} label={labels?.get(w.to)} short /></td>
                <td data-v={w.ts}><time datetime={isoDate(w.ts)} data-ago={w.ts}>{ago(w.ts)}</time></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length ? null : <Empty>No transfers above $5,000 in the last 24 hours, or the first run has not finished.</Empty>}
      </div>
    </div>
  );
}

export interface ScreenerParams { kind: string; health: string; minMcap: string; minVol: string; minLiq: string; chg: string; trust: string }

export function ScreenerPage({ rows, params, total }: { rows: TokenMarketRow[]; params: ScreenerParams; total: number }) {
  const sel = (name: string, value: string, options: [string, string][]) => (
    <select class="input" name={name}>{options.map(([v, l]) => <option value={v} selected={v === value}>{l}</option>)}</select>
  );
  return (
    <div class="wrap page">
      <Crumbs items={[["Markets", "/markets"], ["Screener", null]]} />
      <div class="page-head"><div><h1>Screener</h1><p class="lede">Filter every tracked token by size, liquidity, momentum, and canister health. Filters live in the URL, so any screen is shareable.</p></div></div>
      <form class="card card-pad filters" method="get" action="/markets/screener">
        {sel("kind", params.kind, [["", "Any type"], ["sns", "SNS"], ["ck", "Chain-key"], ["community", "Community"]])}
        {sel("health", params.health, [["", "Any health"], ["healthy", "Healthy only"], ["risk", "At risk, low, or frozen"]])}
        {sel("minMcap", params.minMcap, [["", "Any market cap"], ["100000", "Cap over $100K"], ["1000000", "Cap over $1M"], ["10000000", "Cap over $10M"]])}
        {sel("minLiq", params.minLiq, [["", "Any liquidity"], ["10000", "Liquidity over $10K"], ["100000", "Liquidity over $100K"]])}
        {sel("minVol", params.minVol, [["", "Any volume"], ["1000", "24h volume over $1K"], ["50000", "24h volume over $50K"]])}
        {sel("chg", params.chg, [["", "Any 24h move"], ["up", "Up 24h"], ["down", "Down 24h"], ["up7", "Up 7d"], ["down7", "Down 7d"]])}
        {sel("trust", params.trust, [["", "Any trust score"], ["A", "Trust A only"], ["B", "Trust B or better"], ["C", "Trust C or better"], ["scored", "Scored (exclude insufficient data)"]])}
        <button class="btn btn-primary btn-sm" type="submit">Apply</button>
        <a class="fpill" href="/markets/screener">Reset</a>
      </form>
      <div class="sec-head" style="margin-top:18px">
        <h2>{fmtNum(rows.length)} of {fmtNum(total)} tokens</h2>
        <div class="filters"><input class="input" data-save-name placeholder="Name this filter" aria-label="Filter name" /><button type="button" class="fpill" data-save-filter>Save filter</button></div>
      </div>
      <div class="filters" data-saved-filters style="margin-bottom:12px;font-size:12px;color:var(--muted)"></div>
      <TokenTable rows={rows} />
    </div>
  );
}

export function WatchlistPage({ rows }: { rows: TokenMarketRow[] }) {
  return (
    <div class="wrap page" data-watchlist-page>
      <Crumbs items={[["Markets", "/markets"], ["Watchlist", null]]} />
      <div class="page-head"><div><h1>Watchlist</h1><p class="lede">Star tokens anywhere on the site. Your list is stored in this browser only, no account needed.</p></div></div>
      <div class="callout" data-watchlist-empty hidden style="margin-bottom:14px">Your watchlist is empty. Star a token on the <a class="link" href="/markets">markets page</a> to add it.</div>
      <TokenTable rows={rows} />
    </div>
  );
}

export interface Holding { token: TokenRow; amount: number; usd: number | null }

export function PortfolioPage({ principal, holdings, error, checked, fetchedAt }: { principal: string; holdings: Holding[]; error: string | null; checked: number; fetchedAt: number | null }) {
  const total = holdings.reduce((s, h) => s + (h.usd ?? 0), 0);
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Markets", "/markets"], ["Portfolio", null]]} />
      <div class="page-head"><div><h1>Portfolio</h1><p class="lede">Paste any principal to see its balances across every tracked ledger. Read-only: balances are queried from each ledger directly, nothing is connected or signed.</p></div></div>
      <form class="bigsearch" method="get" action="/portfolio" style="margin:0 0 22px;max-width:none">
        <input type="text" name="p" value={principal} placeholder="Principal, for example xxxxx-xxxxx-...-xxx" autocomplete="off" spellcheck={false} aria-label="Principal" />
      </form>
      {error ? <div class="callout warn">{error}</div> : null}
      {principal && !error ? (
        <>
          <div class="card statbar" style="grid-template-columns:1fr 1fr 1.4fr">
            <div><div class="v c-green">{fmtUsd(total)}</div><div class="k">Total value</div></div>
            <div><div class="v">{holdings.length}</div><div class="k">Tokens held</div></div>
            <div class="meta"><Fresh ts={fetchedAt} source={`icrc1_balance_of on ${checked} ledgers`} staleAfter={120} label="read" /></div>
          </div>
          <div class="card tbl-wrap" style="margin-top:14px">
            <table class="tbl">
              <thead><tr><th>Token</th><th class="r">Balance</th><th class="r">Value</th></tr></thead>
              <tbody>
                {holdings.map((h) => (
                  <tr>
                    <td><a class="name" href={`/token/${h.token.id}`}><TokenLogo id={h.token.id} symbol={h.token.symbol} logo={h.token.logo} /><span><span class="t">{h.token.name}</span><span class="sub">{h.token.symbol}</span></span></a></td>
                    <td class="r num">{fmtNum(h.amount, h.amount < 1 ? 6 : 2)}</td>
                    <td class="r num strong">{fmtUsd(h.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {holdings.length ? null : <Empty>No balances found on the tracked ledgers for this principal's default account.</Empty>}
          </div>
          <p class="note" style="margin-top:10px">Default subaccount only. Staked neurons and subaccounts are not visible from a principal alone.</p>
        </>
      ) : null}
    </div>
  );
}

export interface SearchHit { type: string; title: string; sub?: string; href: string }

export function SearchPage({ q, hits, note }: { q: string; hits: SearchHit[]; note: string | null }) {
  return (
    <div class="wrap page narrow">
      <div class="search-hero" style="padding-top:10px">
        <form class="bigsearch" action="/search" method="get" role="search" data-search>
          <input type="search" name="q" value={q} placeholder="Canister id, principal, account, token, subnet, proposal" autocomplete="off" spellcheck={false} aria-label="Search" />
        </form>
      </div>
      {note ? <div class="callout" style="margin-top:20px">{note}</div> : null}
      <div class="stack" style="margin-top:20px">
        {hits.map((h) => (
          <a class="card prop" href={h.href}>
            <span class="topic">{h.type}</span>
            <div class="b"><h4>{h.title}</h4>{h.sub ? <small class="mono">{h.sub}</small> : null}</div>
          </a>
        ))}
      </div>
      {q && !hits.length && !note ? <div class="card" style="margin-top:20px"><Empty>Nothing matched "{q}". Try a full canister id, a token symbol, or a proposal number.</Empty></div> : null}
    </div>
  );
}

export function UnwatchedCanisterPage({ id, state, probe, history }: {
  id: string; history: CanisterHistory | null; state: { controllers: string[] | null; moduleHash: string | null; subnetId: string | null } | null; probe: { runStatus: string; code: string | null } | null;
}) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Lifeline", "/lifeline"], ["Canister", null]]} />
      <div class="detail-head">
        <div><h1>Canister <HealthPill health={probe?.runStatus === "frozen" ? "frozen" : "unknown"} label={probe ? probe.runStatus.replace(/_/g, " ") : "not reachable"} /></h1>
          <div class="mono muted" style="font-size:12.5px;margin-top:4px">{id} <CopyId id={id} /></div></div>
      </div>
      <div class="callout" style="margin-bottom:16px">Lifeline is not watching this canister yet. This page is a live lookup. Start watching to record its history, project its runway, and get alerts.</div>
      <div class="card kv">
        <div><div class="k">Liveness</div><div class="v">{probe ? probe.runStatus.replace(/_/g, " ") : "unknown"}</div><div class="s"><Conf confidence="inferred" source="probe" /></div></div>
        <div><div class="k">Subnet</div><div class="v mono">{state?.subnetId ? <a href={`/subnet/${state.subnetId}`}>{state.subnetId.slice(0, 17)}...</a> : "n/a"}</div></div>
        <div><div class="k">Module hash</div><div class="v mono">{state?.moduleHash ? `${state.moduleHash.slice(0, 20)}...` : "none installed"}</div></div>
      </div>
      <div class="sec-head"><h2>Controllers</h2></div>
      <div class="card card-pad">
        {state?.controllers?.length ? state.controllers.map((p) => <div class="mono" style="font-size:12px;padding:3px 0">{p}</div>) : <span class="muted">{state?.controllers ? "None. This canister is blackholed." : "Could not be read."}</span>}
        <div class="src" style="margin-top:8px">read_state, certified by the subnet</div>
      </div>
      {history ? <HistoryTimeline history={history} /> : null}
      <form method="post" action="/lifeline/watch" style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap">
        <input type="hidden" name="id" value={id} />
        <button class="btn btn-primary" type="submit">Start watching this canister</button>
        <a class="btn btn-ghost" href={`/lifeline/alerts?canister=${id}`}>Get alerts</a>
      </form>
    </div>
  );
}
