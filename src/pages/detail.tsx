import type { CanisterRow, IncidentRow, MarketRow, PoolRow, TokenRow } from "../db/queries";
import { ago, fmtBytes, fmtCompact, fmtCycles, fmtNum, fmtPct, fmtUsd, fromBase, isoDate, now, pctClass, shortDate, shortId, span } from "../lib/format";
import { Conf, CopyId, Crumbs, Empty, Fresh, HealthPill, TokenLogo, sourceName } from "../ui/components";
import { CanisterTable, IncidentFeed, healthLabelFor, roleLabel, runwayCell } from "./lifeline";
import { PoolsTable, tokenHealthLabel } from "./markets";
import type { CanisterHistory } from "../collectors/history";
import { HistoryTimeline } from "./history";
import { SnsDaoSection, type SnsSectionData } from "./sns";

const parse = <T,>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export function RangeTools({ forId, ranges, current }: { forId: string; ranges: string[]; current: string }) {
  return (
    <div class="chart-tools" data-chart-tools={forId}>
      {ranges.map((r) => <button type="button" class="fpill" data-range={r} aria-pressed={String(r === current)}>{r.toUpperCase()}</button>)}
    </div>
  );
}

const HEALTH_ORDER = ["gone", "frozen", "low", "risk", "life", "unknown", "healthy"];

export interface SnsInfo {
  treasury_icp: number | null; treasury_token: number | null; open_proposals: number | null; neurons: number | null;
  proposals: { id: number; title: string; status: string }[]; fetched_at: number; source: string;
}

export function TokenPage({ t, m, canisters, pools, incidents, sns, holders }: {
  t: TokenRow; m: MarketRow | null; canisters: CanisterRow[]; pools: PoolRow[]; incidents: IncidentRow[]; sns: SnsSectionData | null;
  holders: {
    rows: { account: string; balance: number; share: number | null }[]; total: number | null; top10?: number | null; fetched_at: number; source: string;
    /** Set while our own index is still replaying this ledger: the list then comes from the third-party fallback. */
    indexing?: { percent: number; status: string } | null;
  } | null;
}) {
  const supply = fromBase(t.total_supply, t.decimals);
  const group = canisters.filter((c) => ["ledger", "index", "archive"].includes(c.role));
  const others = canisters.filter((c) => !["ledger", "index", "archive"].includes(c.role));
  const worst = [...group].sort((a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health))[0];
  const badge = tokenHealthLabel({ worst_health: worst?.health ?? null, health_note: worst?.role ?? null, canister_count: group.length });
  const liq = parse<{ dex: string; tvl_usd: number; share: number }[]>(m?.liquidity, []);
  const archives = group.filter((c) => c.role === "archive");
  return (
    <div class="wrap page">
      <Crumbs items={[["Markets", "/markets"], [t.symbol, null]]} />
      <div class="detail-head">
        <TokenLogo id={t.id} symbol={t.symbol} logo={t.logo} size="lg" />
        <div>
          <h1>
            {t.name} <span class="muted" style="font-weight:500;font-size:16px">{t.symbol}</span>
            {t.kind === "sns" ? <span class="chip">SNS</span> : t.kind === "ck" ? <span class="chip">ck</span> : null}
            <button class="star" data-star={t.id} aria-label={`Watch ${t.symbol}`} aria-pressed="false">&#9734;</button>
          </h1>
          <div class="mono muted" style="font-size:12px;margin-top:4px">{t.id} <CopyId id={t.id} /></div>
        </div>
        <div class="px">
          <div class="v">{fmtUsd(m?.price_usd)}</div>
          <div><span class={`num ${pctClass(m?.chg_24h)}`}>{fmtPct(m?.chg_24h)}</span> <span class="muted" style="font-size:12px">24h</span></div>
        </div>
      </div>

      <a class="card card-pad" href="#health" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
        <HealthPill health={badge.health} label={badge.label} />
        <span style="font-size:13px;color:var(--text-2)">
          Lifeline watches {group.length} canister{group.length === 1 ? "" : "s"} behind {t.symbol}: ledger{group.some((c) => c.role === "index") ? ", index" : ""}
          {archives.length ? `, and ${archives.length} archive${archives.length === 1 ? "" : "s"}` : ""}.
          {worst && worst.health !== "healthy" && worst.health !== "unknown" ? ` Most urgent: ${worst.label}.` : ""}
        </span>
        <span class="link" style="margin-left:auto;font-size:12.5px;color:var(--link);font-weight:600">Get alerts for this token &rarr;</span>
      </a>

      <div class="grid-side">
        <div>
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;padding-right:16px">
              <RangeTools forId="price-chart" ranges={["24h", "7d", "30d", "90d", "1y"]} current="7d" />
              <Fresh ts={m?.updated_at} source={parse<string[]>(m?.sources, []).join(" + ") || "DEX canisters"} staleAfter={900} label="price" />
            </div>
            <div class="chart-box" id="price-chart" data-chart={`/api/v1/token/${t.id}/prices`} data-kind="candles" data-range="7d"></div>
          </div>
        </div>
        <div class="card kv" style="grid-template-columns:1fr 1fr">
          <div><div class="k">Market cap</div><div class="v">{fmtCompact(m?.mcap_usd, "$")}</div></div>
          <div><div class="k">FDV</div><div class="v">{fmtCompact(m?.fdv_usd, "$")}</div></div>
          <div><div class="k">24h volume</div><div class="v">{fmtCompact(m?.vol_24h_usd, "$")}</div></div>
          <div><div class="k">Liquidity</div><div class="v">{fmtCompact(m?.tvl_usd, "$")}</div></div>
          <div><div class="k">7d</div><div class={`v ${pctClass(m?.chg_7d)}`}>{fmtPct(m?.chg_7d)}</div></div>
          <div><div class="k">30d</div><div class={`v ${pctClass(m?.chg_30d)}`}>{fmtPct(m?.chg_30d)}</div></div>
          <div><div class="k">Total supply</div><div class="v">{supply != null ? fmtCompact(supply) : "unreadable"}</div><div class="s">{supply != null ? <>ledger icrc1_total_supply &middot; {ago(t.supply_at)}</> : badge.health === "frozen" ? "the ledger is frozen and rejects every query, so market cap cannot be computed" : "ledger did not answer"}</div></div>
          <div><div class="k">Price in ICP</div><div class="v">{m?.price_icp != null ? fmtNum(m.price_icp, m.price_icp < 1 ? 6 : 2) : "n/a"}</div></div>
          <div><div class="k">Transfer fee</div><div class="v">{t.fee ? `${fromBase(t.fee, t.decimals)} ${t.symbol}` : "n/a"}</div></div>
          <div><div class="k">Listed</div><div class="v">{shortDate(t.listed_at)}</div><div class="s">via {t.listed_via}</div></div>
        </div>
      </div>

      <div class="sec-head"><h2>Where liquidity sits</h2></div>
      {liq.length ? (
        <div class="card card-pad">
          <div class="bar split" style="height:10px;border-radius:5px">
            {liq.map((l, i) => <b style={`width:${l.share * 100}%;background:${["var(--blue)", "var(--pink)", "var(--orange)", "var(--purple)", "var(--up)"][i % 5]}`} title={`${l.dex} ${fmtUsd(l.tvl_usd)}`}></b>)}
          </div>
          <div style="display:flex;gap:8px 22px;flex-wrap:wrap;margin-top:12px;font-size:12.5px">
            {liq.map((l, i) => (
              <span><span style={`display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${["var(--blue)", "var(--pink)", "var(--orange)", "var(--purple)", "var(--up)"][i % 5]}`}></span>
                <b>{l.dex}</b> {Math.round(l.share * 100)}% <span class="muted num">{fmtCompact(l.tvl_usd, "$")}</span></span>
            ))}
          </div>
        </div>
      ) : <div class="card"><Empty>No DEX pools found for this token yet.</Empty></div>}
      {pools.length ? <div style="margin-top:12px"><PoolsTable pools={pools} /></div> : null}

      <div class="sec-head" id="health">
        <h2>Canister health <span class="tag">Lifeline</span></h2>
        <a class="btn btn-primary btn-sm" href={`/lifeline/alerts?token=${t.id}`}>Get alerts for {t.symbol}</a>
      </div>
      <CanisterTable rows={group} id="group" showToken={false} />
      {others.length ? (<><div class="sec-head"><h2>Related canisters</h2></div><CanisterTable rows={others} id="related" showToken={false} /></>) : null}
      {incidents.length ? (<><div class="sec-head"><h2>Incident history</h2></div><IncidentFeed items={incidents} /></>) : null}

      {sns ? <SnsDaoSection sns={sns} symbol={t.symbol} /> : null}

      <div class="sec-head"><h2>Top holders</h2>{holders ? <Fresh ts={holders.fetched_at} source={holders.source} staleAfter={86400} /> : null}</div>
      {holders && (holders.total != null || holders.top10 != null || holders.indexing) ? (
        <p class="note" style="margin:-6px 0 12px">
          {holders.total != null ? <><b style="color:var(--text)">{fmtNum(holders.total)}</b> accounts hold {t.symbol}. </> : null}
          {holders.top10 != null ? <>The ten largest hold <b style="color:var(--text)">{(holders.top10 * 100).toFixed(1)}%</b> of supply. </> : null}
          {holders.indexing ? <>ICPWatch is replaying this ledger's blocks into its own index ({holders.indexing.status === "error" || holders.indexing.status === "unsupported" ? "this ledger cannot be replayed right now" : `${holders.indexing.percent}% done`}), so this list still comes from the third-party source.</> : null}
        </p>
      ) : null}
      {holders?.rows.length ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead><tr><th>#</th><th>Account</th><th class="r">Balance</th><th class="r">Share of supply</th></tr></thead>
            <tbody>
              {holders.rows.map((h, i) => (
                <tr>
                  <td class="muted">{i + 1}</td>
                  <td class="mono" style="font-size:12px"><a href={`/search?q=${encodeURIComponent(h.account)}`}>{h.account.length > 40 ? `${h.account.slice(0, 22)}...${h.account.slice(-8)}` : h.account}</a></td>
                  <td class="r num">{fmtCompact(h.balance)}</td>
                  <td class="r num">{h.share != null ? `${(h.share * 100).toFixed(2)}%` : "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>Holder distribution for this token has not been indexed yet.</Empty></div>}

      {t.description ? (<><div class="sec-head"><h2>About</h2></div><div class="card card-pad" style="color:var(--text-2)">{t.description}{t.url ? <> <a class="link" href={t.url} rel="noopener nofollow">{t.url.replace(/^https?:\/\//, "")}</a></> : null}</div></>) : null}
    </div>
  );
}

export function CanisterPage({ c, changes, history, incidents, siblings }: {
  c: CanisterRow; history: CanisterHistory | null; changes: { ts: number; field: string; old_value: string | null; new_value: string | null }[]; incidents: IncidentRow[]; siblings: CanisterRow[];
}) {
  const controllers = parse<string[]>(c.controllers, []);
  const nowTs = now();
  const threshold = c.idle_burn_per_day != null && c.freezing_threshold_s != null ? (c.idle_burn_per_day * c.freezing_threshold_s) / 86400 : null;
  return (
    <div class="wrap page">
      <Crumbs items={[["Lifeline", "/lifeline"], ...(c.token_id ? [[c.token_symbol ?? "Token", `/token/${c.token_id}`] as [string, string]] : []), [c.label, null]]} />
      <div class="detail-head">
        <div>
          <h1>{c.label} <HealthPill health={c.health} label={healthLabelFor(c)} /></h1>
          <div class="mono muted" style="font-size:12.5px;margin-top:4px">{c.id} <CopyId id={c.id} /></div>
        </div>
        <div class="px"><a class="btn btn-primary" href={`/lifeline/alerts?canister=${c.id}`}>Get alerts</a></div>
      </div>

      <div class="card kv">
        <div>
          <div class="k">Cycle balance</div>
          <div class="v">{c.cycles != null ? fmtCycles(c.cycles) : "unknown"}</div>
          <div class="s"><Conf confidence={c.confidence} source={c.cycles_source} /></div>
        </div>
        <div><div class="k">Burn per day</div><div class="v">{c.burn_per_day != null ? fmtCycles(c.burn_per_day) : "n/a"}</div><div class="s">{c.burn_source === "observed" ? "observed from our readings" : c.burn_source === "idle" ? "idle burn reported by controller" : "needs more readings"}</div></div>
        <div><div class="k">Runway</div><div class="v">{runwayCell(c, nowTs)}</div><div class="s">{c.freeze_at ? `freezes around ${shortDate(c.freeze_at)}` : ""}</div></div>
        <div><div class="k">Projected deletion</div><div class="v">{c.delete_at ? shortDate(c.delete_at) : "n/a"}</div><div class="s">{c.delete_at ? `in ${span(c.delete_at - nowTs)} if nothing changes` : ""}</div></div>
        <div><div class="k">Run status</div><div class="v">{c.run_status.replace(/_/g, " ")}</div><div class="s">{c.probed_at ? `probed ${ago(c.probed_at)}` : ""}</div></div>
        <div><div class="k">Freezing threshold</div><div class="v">{threshold != null ? fmtCycles(threshold) : "n/a"}</div><div class="s">{c.freezing_threshold_s != null ? `${Math.round(c.freezing_threshold_s / 86400)} days of idle burn` : "not readable"}</div></div>
        <div><div class="k">Idle burn</div><div class="v">{c.idle_burn_per_day != null ? `${fmtCycles(c.idle_burn_per_day)} / day` : "n/a"}</div></div>
        <div><div class="k">Memory</div><div class="v">{fmtBytes(c.memory_bytes)}</div></div>
      </div>
      <div style="margin-top:8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <Fresh ts={c.measured_at ?? c.probed_at} source={sourceName(c.cycles_source ?? (c.probed_at ? "probe" : null))} staleAfter={1500} label={c.measured_at ? "measured" : "probed"} />
        <span class="src">Role: <b>{roleLabel[c.role] ?? c.role}</b> &middot; discovered via {c.discovered_via} on {shortDate(c.discovered_at)}</span>
      </div>

      <div class="sec-head"><h2>Cycle balance over time</h2></div>
      <div class="card">
        <RangeTools forId="cycles-chart" ranges={["24h", "7d", "30d", "90d", "1y"]} current="7d" />
        <div class="chart-box" id="cycles-chart" data-chart={`/api/v1/canister/${c.id}/readings`} data-range="7d"></div>
      </div>

      <div class="grid-2" style="margin-top:4px">
        <section>
          <div class="sec-head"><h2>Controllers</h2></div>
          <div class="card card-pad">
            {controllers.length ? controllers.map((p) => (
              <div class="mono" style="font-size:12px;padding:4px 0"><a href={`/search?q=${p}`}>{p}</a></div>
            )) : <span class="muted">{c.controllers ? "No controllers: this canister is immutable (blackholed)." : "Not read yet."}</span>}
            <div class="src" style="margin-top:8px">read_state, certified by the subnet</div>
          </div>
          <div class="sec-head"><h2>Module</h2></div>
          <div class="card card-pad">
            <div class="mono" style="font-size:12px;word-break:break-all">{c.module_hash ?? "n/a"}</div>
            {c.subnet_id ? <div class="src" style="margin-top:8px">Subnet <a class="link" href={`/subnet/${c.subnet_id}`}>{shortId(c.subnet_id)}</a></div> : null}
          </div>
        </section>
        <section>
          <HistoryTimeline history={history} changes={changes} discoveredAt={c.discovered_at} />
        </section>
      </div>

      {incidents.length ? (<><div class="sec-head"><h2>Incidents</h2></div><IncidentFeed items={incidents} /></>) : null}
      {siblings.length > 1 ? (<><div class="sec-head"><h2>Same token group</h2></div><CanisterTable rows={siblings} id="siblings" showToken={false} /></>) : null}
    </div>
  );
}
