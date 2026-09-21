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
            <p>Every token, priced across every major DEX. Supply and holders read straight from ICRC ledgers, plus whale tracking and SNS treasuries.</p>
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
            <p>One fast search box over canisters, principals, subnets, and proposals. Governance you can actually read.</p>
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
            <p>Cycle monitoring, freeze alerts, and life support that keeps abandoned canisters alive for pennies until someone adopts them.</p>
            <div class="foot">
              <span>{fmtNum(s.watched)} watched &middot; {fmtNum(s.atRisk)} at risk</span>
              <b>Watch a canister &rarr;</b>
            </div>
          </div>
        </a>
      </div>

      <div class="tenets">
        <span>Fast first load</span>
        <span>Mobile done properly</span>
        <span>Every number shows its source and freshness</span>
      </div>
    </div>
  );
}
