import { COMMANDS } from "../telegram";
import { Crumbs } from "../ui/components";

export function TelegramPage({ live, botName }: { live: boolean; botName: string | null }) {
  const handle = botName ? `@${botName}` : "the ICPWatch bot";
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Lifeline", "/lifeline"], ["Telegram bot", null]]} />
      <div class="page-head">
        <div>
          <h1>ICPWatch on Telegram</h1>
          <p class="lede">Prices, canister health, SNS treasuries, and alerts, in a DM or in your project's group. Everything the bot says comes from the same data as this site, with the same sources.</p>
        </div>
      </div>
      {!live ? <div class="callout warn" style="margin-bottom:18px">The bot is being set up. Commands and group feeds below work as soon as it is live; subscriptions you create on the site with a Telegram chat id are stored and delivered then.</div> : null}

      <div class="sec-head"><h2>1. Start a chat</h2></div>
      <div class="card card-pad prose" style="font-size:13.5px">
        <p>Open {botName ? <a class="link" href={`https://t.me/${botName}`} rel="noopener">{handle}</a> : handle} in Telegram and send <code>/start</code>. The reply includes your chat id, which you can paste into any alert form on this site. Or skip the forms and subscribe from the chat: <code>/watch CHAT</code>, <code>/pricealert CHAT above 0.12</code>.</p>
      </div>

      <div class="sec-head"><h2>2. Add it to a group</h2></div>
      <div class="card card-pad prose" style="font-size:13.5px">
        <p>Add {handle} to the group as a member (no admin rights needed). Group admins can then switch on feeds:</p>
        <ul>
          <li><code>/feed sns on</code>: every new proposal across all SNS DAOs, treasury moves called out</li>
          <li><code>/feed whales on</code>: transfers over $10,000 from our own ledger index</li>
          <li><code>/feed launches on</code>: SNS swaps opening and NNS proposals to create a DAO</li>
          <li><code>/feed lifeline on</code>: canisters going low on cycles or freezing</li>
          <li><code>/feed moves on</code>: price and volume alerts that fired for anyone</li>
        </ul>
        <p>Feeds are batched, several items per message, and capped at 20 messages an hour per chat. <code>/quiet 23 7</code> holds feed posts overnight (set your offset with <code>/tz +2</code>) and sends one digest in the morning. Alerts this chat subscribed to directly are never held.</p>
      </div>

      <div class="sec-head"><h2>Commands</h2></div>
      <div class="card tbl-wrap">
        <table class="tbl">
          <tbody>{COMMANDS.map(([c, d]) => <tr><td class="mono" style="white-space:nowrap">/{c}</td><td>{d}</td></tr>)}</tbody>
        </table>
      </div>
      <div class="src" style="margin-top:10px">The bot never asks for a wallet, a seed phrase, or a payment. Anyone claiming to be ICPWatch and asking for those is not us.</div>
    </div>
  );
}
