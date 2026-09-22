import type { IncidentRow } from "../db/queries";
import { Crumbs } from "../ui/components";
import { IncidentFeed } from "./lifeline";

export interface AlertTarget { type: "canister" | "token"; id: string; label: string; count?: number }

export function AlertsPage({ target, channels, result }: {
  target: AlertTarget | null;
  channels: { email: boolean; telegram: boolean };
  result?: { ok: boolean; message: string } | null;
}) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Lifeline", "/lifeline"], ["Get alerts", null]]} />
      <div class="page-head">
        <div>
          <h1>Get alerts</h1>
          <p class="lede">
            Subscribe to any public canister, or to a whole token: ledger, index, and every archive, including archives that get spawned later. You do not need to control the canister.
          </p>
        </div>
      </div>

      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}

      <form class="card card-pad form" method="post" action="/lifeline/alerts">
        <div class="field">
          <label for="scope">What to watch</label>
          {target ? (
            <>
              <input type="hidden" name="scope_type" value={target.type} />
              <input type="hidden" name="scope_id" value={target.id} />
              <div class="callout">
                <b>{target.label}</b>{" "}
                <span class="mono muted" style="font-size:12px">{target.id}</span>
                {target.type === "token" && target.count ? <div class="muted" style="font-size:12px;margin-top:2px">{target.count} canisters today. New archives are added automatically.</div> : null}
              </div>
              <div class="hint"><a class="link" href="/lifeline/alerts">Choose something else</a></div>
            </>
          ) : (
            <>
              <input id="scope" type="text" name="scope" placeholder="Canister id, ledger id, or token symbol (for example CHAT)" required autocomplete="off" spellcheck={false} />
              <div class="hint">A token symbol or ledger id subscribes you to the whole token group. Any other canister id subscribes to that one canister.</div>
            </>
          )}
        </div>

        <div class="field">
          <label>Alert types</label>
          <div class="checks">
            <label class="check"><input type="checkbox" name="types" value="low_cycles" checked /><span><b>Low cycles</b>Under 14 days until it freezes at the current burn.</span></label>
            <label class="check"><input type="checkbox" name="types" value="frozen" checked /><span><b>Frozen</b>The canister started rejecting calls.</span></label>
            <label class="check"><input type="checkbox" name="types" value="approaching_deletion" checked /><span><b>Approaching deletion</b>Frozen with under 14 days of storage cost left.</span></label>
            <label class="check"><input type="checkbox" name="types" value="burn_anomaly" checked /><span><b>Burn-rate anomaly</b>A spike against the canister's own rolling baseline.</span></label>
            <label class="check"><input type="checkbox" name="types" value="controller_change" checked /><span><b>Controllers changed</b>Someone was added to or removed from the canister's controllers. The ICP version of "admin key changed".</span></label>
            <label class="check"><input type="checkbox" name="types" value="sns_proposal" /><span><b>New SNS proposal</b>For a token subscription on an SNS DAO: every new proposal, as it opens.</span></label>
            <label class="check"><input type="checkbox" name="types" value="treasury_movement" checked /><span><b>Treasury movement</b>A proposal that would transfer or mint from the DAO treasury.</span></label>
            <label class="check"><input type="checkbox" name="types" value="liquidity_drop" checked /><span><b>Liquidity pulled</b>The token's DEX liquidity fell more than 30% in an hour or 50% in a day.</span></label>
            <label class="check"><input type="checkbox" name="types" value="holder_dump" checked /><span><b>Top holder selling</b>A top-10 holder moved more than 1% of supply into a DEX pool within an hour.</span></label>
            <label class="check"><input type="checkbox" name="types" value="module_change" /><span><b>Code changed</b>The canister was upgraded, reinstalled, or uninstalled. Routine for active projects, so off by default.</span></label>
          </div>
        </div>

        <div class="field">
          <label>Where to send it</label>
          <div class="seg" role="radiogroup" aria-label="Channel">
            <label><input type="radio" name="channel" value="email" checked />Email</label>
            <label><input type="radio" name="channel" value="telegram" />Telegram</label>
            <label><input type="radio" name="channel" value="discord" />Discord</label>
            <label><input type="radio" name="channel" value="webhook" />Webhook</label>
          </div>
        </div>
        <div class="field">
          <label for="target">Address</label>
          <input id="target" type="text" name="target" required placeholder="you@example.com, Telegram chat id, Discord webhook URL, or https:// endpoint" autocomplete="off" spellcheck={false} />
          <div class="hint">
            Email: we send one confirmation link first{channels.email ? "" : " (email delivery is being set up, so subscriptions are stored and confirmed once it is live)"}.
            Telegram: message the ICPWatch bot with /start to get your chat id, or subscribe from the chat with /watch (<a class="link" href="/telegram">how</a>){channels.telegram ? "" : " (bot is being set up)"}.
            Discord: paste a channel webhook URL. Webhook: we POST signed JSON, with the signing secret shown once after you subscribe.
          </div>
        </div>
        {/* Honeypot: real users never see or fill this. */}
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" type="submit">Subscribe</button>
          <span class="note">One alert per incident, plus one note when it resolves. Every message has a one-click unsubscribe.</span>
        </div>
      </form>

      <div class="sec-head"><h2>How alerts behave</h2></div>
      <div class="card card-pad prose" style="font-size:13.5px">
        <ul style="margin-bottom:0">
          <li><strong>One per incident.</strong> An incident opens once and stays open. You are not pinged again while the balance keeps falling.</li>
          <li><strong>Hysteresis.</strong> A low-cycles incident opens under 14 days of runway and only resolves after the runway is back above 21 days on two checks in a row, so a canister hovering at the line does not flap.</li>
          <li><strong>Own baseline.</strong> Burn anomalies compare the last six hours against the median and spread of that canister's own daily burn. A canister that is always busy does not fire. A quiet one that suddenly burns several times its norm does.</li>
          <li><strong>Resolved notice.</strong> When it recovers you get exactly one message saying so, with how long it was open.</li>
        </ul>
      </div>
    </div>
  );
}

export function IncidentsPage({ items }: { items: IncidentRow[] }) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Lifeline", "/lifeline"], ["Incidents", null]]} />
      <div class="page-head"><div><h1>Incidents</h1><p class="lede">Every incident Lifeline has opened, newest first. One entry per incident, not per check.</p></div></div>
      <IncidentFeed items={items} />
    </div>
  );
}
