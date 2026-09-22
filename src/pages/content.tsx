import type { Child } from "hono/jsx";
import { ago, fmtCycles, shortDate, span, now } from "../lib/format";
import { Crumbs, Empty, Fresh } from "../ui/components";
import type { LifeSupportItem } from "./lifeline";

function Prose({ title, lede, children }: { title: string; lede?: string; children?: Child }) {
  return (
    <div class="wrap page narrow prose">
      <h1>{title}</h1>
      {lede ? <p class="lede">{lede}</p> : null}
      {children}
    </div>
  );
}

export const HowItWorks = () => (
  <Prose title="How it works" lede="ICPWatch is three products on one data layer: Lifeline watches canister health, Markets prices tokens across DEXs, and Network makes the chain browsable.">
    <h2>Lifeline</h2>
    <p>
      Every canister on the Internet Computer pays for itself in cycles. When the balance drops below the freezing threshold the canister freezes and rejects calls.
      If it then burns through what is left on storage cost alone, it is uninstalled and its state is gone. For a ledger archive that means transaction history is lost for good.
    </p>
    <p>Lifeline models every token as a group: ledger, index, and all archive canisters. Archives are discovered from the ledger itself and re-discovered every hour, so a newly spawned archive is watched without anyone adding it.</p>
    <h3>Where balances come from</h3>
    <p>A canister's cycle balance is only visible to its controllers, so Lifeline uses every public path and labels each number with how it was obtained:</p>
    <ul>
      <li><strong>Measured.</strong> Read from a controller that answers publicly (the SNS root canister for every SNS, the NNS root canister for ICP and ck tokens, a blackhole controller) or from the canister's own metrics endpoint.</li>
      <li><strong>Inferred.</strong> Derived from partial data, for example a projection that had to assume the default 30 day freezing threshold.</li>
      <li><strong>Probed.</strong> The balance is not readable, so Lifeline sends a query and checks the response. A frozen canister answers with a specific error code, which is enough to detect freezing even with no balance.</li>
      <li><strong>Unknown.</strong> Nothing readable yet.</li>
    </ul>
    <h3>Projections</h3>
    <p>
      The freezing threshold in cycles is idle burn per day times the threshold in days. Time to freeze is the balance above that threshold divided by the observed burn rate.
      After freezing, only idle cost burns, so time to deletion is the remaining balance divided by idle burn. Top-ups are excluded from burn calculations.
    </p>
    <h2>Markets</h2>
    <p>Prices are read from DEX canisters directly and weighted by pool liquidity, so one thin pool cannot move the headline price. Supply comes from each ledger's <code>icrc1_total_supply</code>. Each token shows which DEX its liquidity actually sits on.</p>
    <h2>Network</h2>
    <p>Proposals are read from the NNS governance canister. Controllers and module hashes are read from the certified state tree. Subnet and network-wide metrics come from the public IC metrics API, isolated behind an adapter so it can be swapped.</p>
    <h2>Provenance</h2>
    <p>Every number carries a source and a timestamp. A green dot means fresh, amber means the collector is behind, red means the source has been unreachable for a while. We would rather show an honest "unknown" than a confident guess.</p>
  </Prose>
);

export const Faq = () => (
  <Prose title="FAQ">
    <h3>Do I need to control a canister to monitor it?</h3>
    <p>No. Lifeline watches public signals. You can subscribe to any canister or any token group.</p>
    <h3>Why does a canister show "unknown" cycles?</h3>
    <p>Cycle balances are private to controllers. If a canister has no public controller, no metrics endpoint, and no cycles method, the balance cannot be read by anyone outside. Lifeline still probes it, so you will know if it freezes.</p>
    <h3>How do I make my canister measurable?</h3>
    <p>Add a blackhole canister as a controller, or expose a cycles metric on an HTTP metrics endpoint. Either makes the balance publicly readable without giving anyone control. Then send a <a href="/listing-request">listing request</a>.</p>
    <h3>What is life support?</h3>
    <p>A preservation service for abandoned canisters. It sends small top-ups so the canister stays above zero cycles but below its freezing threshold. It stays frozen, burns only storage cost, and can be adopted and revived later. See <a href="/lifeline/life-support">On Life Support</a>.</p>
    <h3>Is this financial advice?</h3>
    <p>No. See the <a href="/disclaimer">disclaimer</a>.</p>
    <h3>Can I trade on ICPWatch?</h3>
    <p>No. ICPWatch is read-only. It never asks you to connect a wallet.</p>
    <h3>How do watchlists and saved filters work without an account?</h3>
    <p>They are stored in your browser. Nothing is sent to us.</p>
  </Prose>
);

export const Docs = () => (
  <Prose title="Documentation" lede="Short guides to the parts of ICPWatch that are not obvious.">
    <h2>Guides</h2>
    <ul>
      <li><a href="/how-it-works">How it works</a>: the data model, confidence labels, projections.</li>
      <li><a href="/data-sources">Data sources</a>: every source, what it provides, and how fresh it is.</li>
      <li><a href="/api">API</a>: JSON endpoints for everything on the site.</li>
      <li><a href="/lifeline/alerts">Alerts</a>: subscribing, channels, and how dedup works.</li>
    </ul>
    <h2>Webhook payload</h2>
    <p>Webhook subscribers receive a POST with a JSON body and an <code>X-ICPWatch-Signature</code> header containing the hex HMAC-SHA256 of the raw body, keyed with the secret shown at subscribe time.</p>
    <pre><code>{`{
  "event": "incident.opened",          // or "incident.resolved"
  "incident": {
    "id": 1842,
    "type": "low_cycles",              // low_cycles | frozen | approaching_deletion | burn_anomaly
    "severity": "warn",
    "title": "Low cycles: CHAT Archive 2",
    "detail": "0.62 T left, about 12 days until it freezes...",
    "opened_at": 1790000000,
    "resolved_at": null
  },
  "canister": { "id": "...", "label": "...", "role": "archive", "token": "CHAT", "cycles": 620000000000, "confidence": "measured" },
  "url": "https://icpwatch.com/canister/..."
}`}</code></pre>
    <h2>Health states</h2>
    <table>
      <thead><tr><th>State</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><td>Healthy</td><td>More than 45 days until freeze at the current burn.</td></tr>
        <tr><td>At risk</td><td>Under 45 days until freeze.</td></tr>
        <tr><td>Low cycles</td><td>Under 14 days until freeze.</td></tr>
        <tr><td>Frozen</td><td>Rejecting calls. Burning storage cost until deletion.</td></tr>
        <tr><td>Life support</td><td>Deliberately held frozen and above zero by ICPWatch.</td></tr>
        <tr><td>Responding</td><td>Balance not readable, but the canister answers queries.</td></tr>
      </tbody>
    </table>
  </Prose>
);

export const ApiDocs = () => (
  <Prose title="API" lede="Everything on the site is available as JSON. No key needed. Responses include source and fetched_at so provenance travels with the data.">
    <p>Base URL: <code>https://icpwatch.com/api/v1</code>. Please cache on your side and keep it under one request per second. CORS is open for GET.</p>
    <table>
      <thead><tr><th>Endpoint</th><th>Returns</th></tr></thead>
      <tbody>
        <tr><td><code>GET /lifeline/summary</code></td><td>Headline counts and last collection time.</td></tr>
        <tr><td><code>GET /lifeline/canisters?state=risk|frozen|archive</code></td><td>Watched canisters with cycles, burn, runway, status, confidence.</td></tr>
        <tr><td><code>GET /canister/:id</code></td><td>One canister with projections and open incidents.</td></tr>
        <tr><td><code>GET /canister/:id/readings?range=7d</code></td><td>Cycle balance time series.</td></tr>
        <tr><td><code>GET /tokens</code></td><td>Token list with market data and the Lifeline health badge.</td></tr>
        <tr><td><code>GET /token/:id</code></td><td>Token, market, pools, and its canister group.</td></tr>
        <tr><td><code>GET /token/:id/prices?range=30d</code></td><td>Price series (OHLC where available).</td></tr>
        <tr><td><code>GET /pools</code></td><td>Pools across DEXs ranked by 24h volume.</td></tr>
        <tr><td><code>GET /incidents</code></td><td>Recent incidents, open and resolved.</td></tr>
        <tr><td><code>GET /network/summary</code></td><td>Headline network metrics.</td></tr>
        <tr><td><code>GET /subnets</code></td><td>Subnets with burn, size, and throughput.</td></tr>
        <tr><td><code>GET /proposals?status=open</code></td><td>NNS proposals.</td></tr>
        <tr><td><code>GET /search?q=</code></td><td>Resolve any id, symbol, or name.</td></tr>
        <tr><td><code>GET /portfolio/:principal</code></td><td>Balances across every tracked ledger for a principal.</td></tr>
      </tbody>
    </table>
    <p>Ranges: <code>24h</code>, <code>7d</code>, <code>30d</code>, <code>90d</code>, <code>1y</code>. Timestamps are unix seconds. Cycles are integers.</p>
  </Prose>
);

export const Changelog = () => (
  <Prose title="Changelog">
    <h2>0.2.0, September 2026</h2>
    <ul>
      <li>Lifeline: every token as one group (ledger, index, archives) with its worst state, and the long tail of DEX tokens is now watched too. Dozens of token ledgers turned out to be uninstalled while their pools are still listed.</li>
      <li>Own block indexer: holders, concentration, large transfers, and daily activity replayed from ledger and archive blocks, with honest progress while a ledger is still syncing.</li>
      <li>Account pages for any principal or ICP account identifier: balances across ledgers and recent transactions, read from the ledgers and index canisters.</li>
      <li>Upgrade and controller history for every watched canister from the on-chain change log, plus two new alert types: controllers changed, and code changed.</li>
      <li>SNS DAO analytics on token pages: treasury in ICP, tokens, and USD, how much of the raised ICP has left, neurons, turnout, and proposal outcomes.</li>
      <li>Network and subnet charts: block rate, cycle burn, messages, and canister counts over time.</li>
      <li>Life support engine with a dry-run mode, spend caps, a kill switch, and an append-only audit log. It is switched off until funded and enabled.</li>
      <li>Burn estimates now need six hours of readings before they drive projections or alerts.</li>
    </ul>
    <h2>0.1.0, September 2026</h2>
    <ul>
      <li>Lifeline: live canister health for ICP, ck tokens, and every SNS, with ledger, index, and archives grouped per token.</li>
      <li>Archive auto-discovery from each ledger, hourly.</li>
      <li>Confidence labels on every balance: measured, inferred, probed, unknown.</li>
      <li>Alerts: low cycles, frozen, approaching deletion, and burn-rate anomaly against each canister's own baseline. Email, Telegram, Discord, and signed webhooks.</li>
      <li>Markets: token list with prices aggregated across DEXs, liquidity location per token, and a Lifeline health badge in the list.</li>
      <li>Network: global search, subnets by burn, and readable NNS proposals.</li>
    </ul>
  </Prose>
);

export const Privacy = () => (
  <Prose title="Privacy">
    <p>ICPWatch is a read-only analytics site. It does not use accounts, advertising trackers, or third-party analytics scripts.</p>
    <h2>What we store</h2>
    <ul>
      <li><strong>Alert subscriptions.</strong> The address you give us (email, Telegram chat id, Discord or webhook URL) and what you subscribed to. It is used only to deliver those alerts. Every message includes a one-click unsubscribe that deletes the record.</li>
      <li><strong>Form submissions.</strong> Listing and contact requests, until they are handled.</li>
      <li><strong>Server logs.</strong> Standard request logs kept by our hosting provider (Cloudflare) for security and debugging.</li>
    </ul>
    <h2>What stays in your browser</h2>
    <p>Watchlists, saved screener filters, portfolio addresses you look up, and your theme choice are kept in local storage on your device and are never sent to us.</p>
    <h2>On-chain data</h2>
    <p>Everything ICPWatch displays about canisters, tokens, and accounts is public blockchain data.</p>
    <h2>Contact</h2>
    <p>Questions or deletion requests: use the <a href="/contact">contact form</a>.</p>
  </Prose>
);

export const Terms = () => (
  <Prose title="Terms">
    <p>By using ICPWatch you agree to these terms.</p>
    <h2>The service</h2>
    <p>ICPWatch provides information about the Internet Computer network on an as-is basis. Data is collected from public sources and may be delayed, incomplete, or wrong. Availability is not guaranteed.</p>
    <h2>Alerts</h2>
    <p>Alerts are best effort. Do not rely on ICPWatch as your only safeguard against a canister running out of cycles.</p>
    <h2>Acceptable use</h2>
    <p>Do not abuse the API, attempt to disrupt the service, or use it to harass anyone. Automated access should respect the limits on the <a href="/api">API page</a>.</p>
    <h2>Liability</h2>
    <p>To the extent permitted by law, ICPWatch is not liable for losses arising from use of the site or reliance on its data.</p>
    <h2>Changes</h2>
    <p>These terms may change. Continued use after a change means you accept the new terms.</p>
  </Prose>
);

export const Disclaimer = () => (
  <Prose title="Disclaimer">
    <p>Nothing on ICPWatch is financial, investment, legal, or tax advice. Token prices, market caps, and health indicators are informational only. Crypto assets are volatile and you can lose everything you put in. Do your own research.</p>
    <p>A Lifeline health badge describes the cycle status of a token's canisters. It is not a statement about the quality, safety, or legitimacy of a project.</p>
    <p>ICPWatch is independent and is not affiliated with the DFINITY Foundation.</p>
  </Prose>
);

export function FormPage({ kind, result }: { kind: "listing" | "contact"; result?: { ok: boolean; message: string } | null }) {
  const listing = kind === "listing";
  return (
    <div class="wrap page narrow">
      <div class="page-head">
        <div>
          <h1>{listing ? "Listing request" : "Contact"}</h1>
          <p class="lede">{listing
            ? "Ask us to track a token or a canister. SNS tokens and ck tokens are discovered automatically, so this is for community tokens and standalone canisters."
            : "Questions, corrections, partnership ideas, or a canister you want to adopt."}</p>
        </div>
      </div>
      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}
      <form class="card card-pad form" method="post" action={listing ? "/listing-request" : "/contact"}>
        {listing ? (
          <>
            <div class="field"><label for="ledger">Ledger or canister id</label><input id="ledger" name="canister" type="text" required placeholder="xxxxx-xxxxx-xxxxx-xxxxx-cai" spellcheck={false} autocomplete="off" /></div>
            <div class="field"><label for="index">Index canister id (optional)</label><input id="index" name="index" type="text" placeholder="xxxxx-xxxxx-xxxxx-xxxxx-cai" spellcheck={false} autocomplete="off" /></div>
            <div class="field"><label for="site">Project site (optional)</label><input id="site" name="url" type="url" placeholder="https://" /></div>
          </>
        ) : null}
        <div class="field"><label for="email">Your email{listing ? " (optional)" : ""}</label><input id="email" name="email" type="email" required={!listing} placeholder="you@example.com" /></div>
        <div class="field"><label for="msg">{listing ? "Anything we should know" : "Message"}</label><textarea id="msg" name="message" required={!listing}></textarea></div>
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
        <div><button class="btn btn-primary" type="submit">Send</button></div>
      </form>
    </div>
  );
}

export function LifeSupportPage({ items, frozen, adopt }: {
  items: (LifeSupportItem & { budget_cycles: number; spent_cycles: number })[];
  frozen: { id: string; label: string; delete_at: number | null; cycles: number | null; token_symbol: string | null }[];
  adopt: string | null;
}) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Lifeline", "/lifeline"], ["On Life Support", null]]} />
      <div class="page-head">
        <div>
          <h1>On Life Support <span class="badge-only">Adoption registry</span></h1>
          <p class="lede">Abandoned canisters kept from deletion at minimum cost, so a project or community can claim them and bring them back.</p>
        </div>
      </div>

      <div class="callout" style="margin-bottom:22px">
        <b>Status: not active yet.</b> Life support spends real cycles, so it stays switched off until Lifeline's monitoring data has a track record.
        The registry, budgets, and audit log below are live and will fill in when it is enabled.
      </div>

      <div class="sec-head" style="margin-top:0"><h2>Preserved canisters</h2></div>
      {items.length ? (
        <div class="stack">
          {items.map((l) => (
            <div class="card adopt">
              <div class="b">
                <h4><a href={`/canister/${l.canister_id}`}>{l.label ?? l.canister_id}</a></h4>
                <p>{l.what}</p>
                {l.story ? <p class="muted" style="font-size:12px">{l.story}</p> : null}
                <small>
                  preserved for {span(now() - l.since)} &middot; {l.monthly_cycles != null ? `${fmtCycles(l.monthly_cycles)} / mo` : "cost being measured"} &middot; spent {fmtCycles(l.spent_cycles)} of {fmtCycles(l.budget_cycles)} budget
                </small>
              </div>
              <a class="btn btn-primary btn-sm" href={`/contact?adopt=${l.canister_id}`}>Adopt</a>
            </div>
          ))}
        </div>
      ) : <div class="card"><Empty>No canisters are on life support yet.</Empty></div>}

      <div class="sec-head"><h2>Candidates: frozen right now</h2></div>
      {frozen.length ? (
        <div class="card tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Canister</th><th class="r">Cycles</th><th>Deletion</th></tr></thead>
            <tbody>
              {frozen.map((c) => (
                <tr>
                  <td><a class="name" href={`/canister/${c.id}`}><span><span class="t">{c.label}</span><span class="cid">{c.id}</span></span></a></td>
                  <td class="r num">{c.cycles != null ? fmtCycles(c.cycles) : "unknown"}</td>
                  <td>{c.delete_at ? `${shortDate(c.delete_at)} (${span(c.delete_at - now())})` : "not projectable"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div class="card"><Empty>No watched canister is frozen right now.</Empty></div>}

      <div class="prose" style="margin-top:34px" id="adopt">
        <h2>How life support works</h2>
        <p><strong>Preservation, not restoration.</strong> A frozen canister burns only its idle storage cost. If the balance reaches zero the canister is uninstalled and its state is deleted. Life support sends small top-ups so the balance stays above zero but below the freezing threshold. The canister stays frozen on purpose, which is the cheapest state in which it still exists.</p>
        <p><strong>Sized per canister.</strong> Each top-up is computed from that canister's freezing threshold and idle burn, with a safety margin, so a top-up can never unfreeze it by accident. State is verified after every top-up and an alert fires if anything unexpected happens.</p>
        <p><strong>Hard limits.</strong> A global spend cap, a budget per canister, a manual kill switch, and an append-only audit log of every top-up, published here.</p>
        <h2>Adopting a canister</h2>
        <p>If you are the original team, or a community that wants to revive a project, <a href={adopt ? `/contact?adopt=${adopt}` : "/contact"}>get in touch</a>. Adoption means the existing controllers (or the SNS, for DAO-controlled canisters) take funding back over. ICPWatch never takes control of a canister: top-ups are permissionless deposits and nothing more.</p>
      </div>
    </div>
  );
}

export interface IndexStatus {
  overview: { ledgers: number; complete: number; failing: number; blocksIndexed: number; blocksTotal: number; percent: number };
  failures: { ledger: string; symbol: string | null; status: string; fail_reason: string | null; fail_canister: string | null; failed_since: number | null; fails: number; retry_at: number; error: string | null }[];
}

const FAIL_TEXT: Record<string, string> = {
  frozen: "the ledger is frozen (out of cycles)", uninstalled: "the ledger was uninstalled", no_get_transactions: "custom ledger without a block API",
  archive_gap: "a block range is held by no canister", archive_unreachable: "an archive is frozen or unreachable", decode_error: "blocks in a shape we cannot read", other: "other",
};

export function StatusPage({ runs, index }: { runs: { job: string; started_at: number; ms: number | null; ok: number; stats: string | null; error: string | null }[]; index?: IndexStatus }) {
  const allOk = runs.length > 0 && runs.every((r) => r.ok && now() - r.started_at < 3 * 3600);
  return (
    <div class="wrap page narrow">
      <div class="page-head">
        <div><h1>Status</h1><p class="lede">Collector health. If a job is failing or late, the numbers it feeds are marked stale across the site.</p></div>
        <span class={`pill ${allOk ? "ok" : runs.length ? "risk" : "unk"}`}>{allOk ? "All collectors healthy" : runs.length ? "Degraded" : "Waiting for first runs"}</span>
      </div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Job</th><th>Last run</th><th class="r">Duration</th><th>Result</th><th class="hide-m">Details</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr>
                <td class="strong">{r.job}</td>
                <td><Fresh ts={r.started_at} source="" staleAfter={r.job === "network" || r.job === "discovery" ? 5400 : 1500} label="" /></td>
                <td class="r num">{r.ms != null ? `${(r.ms / 1000).toFixed(1)} s` : "n/a"}</td>
                <td><span class={`pill ${r.ok ? "ok" : "low"}`}>{r.ok ? "ok" : "failed"}</span></td>
                <td class="hide-m mono muted" style="font-size:11px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.error ?? r.stats ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length ? null : <Empty>No collector has run yet. {ago(null)}</Empty>}
      </div>
      {index ? (
        <>
          <div class="sec-head"><h2>Block index</h2><span class="muted" style="font-size:12px">{index.overview.complete} of {index.overview.ledgers} ledgers complete &middot; {index.overview.percent}% of known blocks replayed</span></div>
          <div class="card tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Ledger</th><th>Why it cannot be indexed</th><th class="hide-m">Canister at fault</th><th>Since</th></tr></thead>
              <tbody>
                {index.failures.map((f) => (
                  <tr>
                    <td><a href={`/token/${f.ledger}`} style="font-weight:600">{f.symbol ?? f.ledger.slice(0, 11)}</a></td>
                    <td>{FAIL_TEXT[f.fail_reason ?? "other"] ?? f.fail_reason}</td>
                    <td class="hide-m mono" style="font-size:11px">{f.fail_canister && f.fail_canister !== f.ledger ? <a href={`/canister/${f.fail_canister}`}>{f.fail_canister}</a> : ""}</td>
                    <td>{f.failed_since ? shortDate(f.failed_since) : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {index.failures.length ? null : <Empty>Every probed ledger is indexable.</Empty>}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function NotFound({ what }: { what?: string }) {
  return (
    <div class="wrap page narrow" style="text-align:center;padding-top:80px">
      <h1 style="font-size:44px">404</h1>
      <p class="muted" style="margin:10px 0 24px">{what ?? "That page does not exist."}</p>
      <form class="bigsearch" action="/search" method="get" role="search" data-search>
        <input type="search" name="q" placeholder="Search for a canister, token, subnet, or proposal" autocomplete="off" aria-label="Search" />
      </form>
    </div>
  );
}
