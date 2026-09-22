import { fmtCompact, fmtNum } from "../lib/format";

export interface HomeStats {
  tokens: number; dexes: number; subnets: number | null; canisters: number | null; watched: number; preserved: number; atRisk: number;
}

export function HomePage({ s }: { s: HomeStats }) {
  return (
    <div class="wrap page" style="max-width:1100px">
      <section class="hero">
        <div class="eyebrow">icpwatch.com</div>
        <h1>See everything happening on the Internet Computer</h1>
        <div class="rule" aria-hidden="true"></div>
        <p>
          Token markets aggregated across every DEX, a network explorer that is actually fast, and Lifeline, canister health monitoring no one else offers.
        </p>
        <div class="cta">
          <a class="btn btn-primary btn-lg" href="/lifeline">Explore Lifeline</a>
          <a class="btn btn-ghost btn-lg" href="/markets">View markets</a>
        </div>
      </section>

      <div class="grid-3">
        <a class="card pcard" href="/markets">
          <div class="top">
            <span class="ico g-markets" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z" /></svg>
            </span>
          </div>
          <div class="body">
            <h3>Markets</h3>
            <p>Every token, priced across every major DEX, with the things no other markets site shows.</p>
            <ul class="feat">
              <li>Trust score on every token, method published</li>
              <li>Holders from our own ledger index, treasuries and pools named</li>
              <li>Chain Fusion reserves: is ckBTC backed, live</li>
              <li>Every SNS DAO: treasuries, proposals, unlocks</li>
              <li>Every number shows its source and freshness</li>
            </ul>
            <div class="foot">
              <span>{fmtNum(s.tokens)} tokens &middot; {s.dexes} {s.dexes === 1 ? "DEX" : "DEXs"}</span>
              <b>Browse tokens &rarr;</b>
            </div>
          </div>
        </a>
        <a class="card pcard" href="/network">
          <div class="top">
            <span class="ico g-network" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" /></svg>
            </span>
          </div>
          <div class="body">
            <h3>Network</h3>
            <p>The explorer that is actually fast, with everything linked together.</p>
            <ul class="feat">
              <li>One search box: canisters, principals, accounts, tokens, subnets, proposals</li>
              <li>Entity labels: who is behind an account</li>
              <li>Subnets ranked by burn, with charts</li>
              <li>NNS proposals you can read</li>
              <li>Fast first load: server rendered, no app shell to wait on</li>
            </ul>
            <div class="foot">
              <span>{s.subnets != null ? `${fmtNum(s.subnets)} subnets` : "subnets"} &middot; {s.canisters != null ? `${fmtCompact(s.canisters)} canisters` : "canisters"}</span>
              <b>Explore &rarr;</b>
            </div>
          </div>
        </a>
        <a class="card pcard" href="/lifeline">
          <div class="top">
            <span class="ico g-lifeline" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M12 6v12M6 12h12" /></svg>
            </span>
          </div>
          <div class="body">
            <h3>Lifeline</h3>
            <p>Canister health for the whole Internet Computer. Only on ICPWatch.</p>
            <ul class="feat">
              <li>Cycles, burn, and time to freeze for every token's ledger, index, and archives</li>
              <li>Alerts: low cycles, frozen, controller or code changed</li>
              <li>Fund any canister straight through the CMC</li>
              <li>Life support for abandoned canisters</li>
              <li>Mobile done properly, so you can check from anywhere</li>
            </ul>
            <div class="foot">
              <span>{fmtNum(s.watched)} watched &middot; {fmtNum(s.atRisk)} at risk</span>
              <b>Watch a canister &rarr;</b>
            </div>
          </div>
        </a>
      </div>

    </div>
  );
}
