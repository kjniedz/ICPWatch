// /markets/alerts: price and volume alert signup, plus the public "what just moved" feed.
import type { TokenRow } from "../db/queries";
import type { PriceEventRow } from "../alerts/price";
import { ago, fmtUsd } from "../lib/format";
import { Crumbs, Empty, TokenLogo } from "../ui/components";

const KIND_TEXT: Record<string, string> = { above: "crossed above", below: "dropped below", move_pct: "big move", volume_x: "volume spike" };

export function PriceAlertsPage({ token, price, channels, result, events, form }: {
  token: TokenRow | null; price: number | null; channels: { email: boolean; telegram: boolean };
  result?: { ok: boolean; message: string } | null; events: PriceEventRow[]; form?: Record<string, string>;
}) {
  const v = (k: string) => form?.[k] ?? "";
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Markets", "/markets"], ["Price alerts", null]]} />
      <div class="page-head">
        <div>
          <h1>Price and volume alerts</h1>
          <p class="lede">Get a message when a token crosses a price, moves more than a set percentage, or trades several times its usual volume. Prices are our own aggregation across every ICP DEX, checked every five minutes. One message per event, then a cooldown you choose.</p>
        </div>
      </div>

      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}

      <div class="grid-2" style="align-items:start">
        <form class="card card-pad form" method="post" action="/markets/alerts">
          <div class="field">
            <label for="token">Token</label>
            {token ? (
              <>
                <input type="hidden" name="token" value={token.id} />
                <div class="callout" style="display:flex;gap:10px;align-items:center"><TokenLogo id={token.id} symbol={token.symbol} logo={token.logo} /><b>{token.name} ({token.symbol})</b>{price != null ? <span class="muted">now {fmtUsd(price)}</span> : null}</div>
                <div class="hint"><a class="link" href="/markets/alerts">Choose another token</a></div>
              </>
            ) : <input id="token" type="text" name="token" placeholder="Symbol or ledger id, for example CHAT" required autocomplete="off" spellcheck={false} value={v("token")} />}
          </div>
          <div class="field">
            <label>Conditions <span class="muted" style="font-weight:400">(set any, all are checked)</span></label>
            <div class="grid-2" style="gap:10px">
              <label class="sub"><span>Price above (USD)</span><input type="text" inputmode="decimal" name="above" placeholder="0.15" value={v("above")} /></label>
              <label class="sub"><span>Price below (USD)</span><input type="text" inputmode="decimal" name="below" placeholder="0.05" value={v("below")} /></label>
              <label class="sub"><span>Moves more than (%)</span><input type="text" inputmode="decimal" name="move_pct" placeholder="10" value={v("move_pct")} /></label>
              <label class="sub"><span>Move window</span><select name="window" class="input"><option value="24h" selected={v("window") !== "1h"}>24 hours</option><option value="1h" selected={v("window") === "1h"}>1 hour</option></select></label>
              <label class="sub"><span>Volume above (x its 7-day average)</span><input type="text" inputmode="decimal" name="volume_x" placeholder="3" value={v("volume_x")} /></label>
              <label class="sub"><span>Cooldown (hours)</span><input type="text" inputmode="numeric" name="cooldown_h" placeholder="6" value={v("cooldown_h")} /></label>
            </div>
            <div class="hint">Above and below re-arm once the price crosses back by 2%. A move alert re-arms once the move is under half your threshold. Nothing fires on a stale price.</div>
          </div>
          <div class="field">
            <label>Where to send it</label>
            <div class="seg" role="radiogroup" aria-label="Channel">
              <label><input type="radio" name="channel" value="email" checked={!v("channel") || v("channel") === "email"} />Email</label>
              <label><input type="radio" name="channel" value="telegram" checked={v("channel") === "telegram"} />Telegram</label>
              <label><input type="radio" name="channel" value="discord" checked={v("channel") === "discord"} />Discord</label>
              <label><input type="radio" name="channel" value="webhook" checked={v("channel") === "webhook"} />Webhook</label>
            </div>
          </div>
          <div class="field">
            <label for="target">Address</label>
            <input id="target" type="text" name="target" required placeholder="you@example.com, Telegram chat id, Discord webhook URL, or https:// endpoint" autocomplete="off" spellcheck={false} value={v("target")} />
            <div class="hint">
              Email: one confirmation link first{channels.email ? "" : " (email delivery is being set up; the subscription is stored and confirmed once it is live)"}.
              Telegram: message the ICPWatch bot with /start to get your chat id{channels.telegram ? "" : " (bot is being set up)"}.
            </div>
          </div>
          <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
          <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit">Create alert</button>
            <span class="note">Every message has a one-click unsubscribe.</span>
          </div>
        </form>

        <div>
          <div class="sec-head" style="margin-top:0"><h2>What just moved</h2><span class="note">alerts that fired, no addresses</span></div>
          {events.length ? (
            <div class="card">
              {events.map((e) => (
                <div class="feed-item">
                  <span class={e.kind === "volume_x" ? "d life" : "d ok"}></span>
                  <div class="body">
                    <div class="title"><a href={`/token/${e.token_id}`}>{e.symbol}</a> <span class="chip">{KIND_TEXT[e.kind] ?? e.kind}</span></div>
                    <div class="meta"><span>{e.detail}</span><span>{ago(e.ts)}</span></div>
                  </div>
                </div>
              ))}
            </div>
          ) : <div class="card"><Empty>No alert has fired yet. The first ones show up here as soon as rules exist and the market moves.</Empty></div>}
        </div>
      </div>
    </div>
  );
}
