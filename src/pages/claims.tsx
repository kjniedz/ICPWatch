// Claim a project: start, instructions per method, status, and the profile editor.
import { CLAIM_ACCOUNT, type Claim, type Profile } from "../claims";
import type { TokenRow } from "../db/queries";
import { KIND_TEXT } from "../meta";
import { shortDate } from "../lib/format";
import { Crumbs } from "../ui/components";

const METHOD_TEXT: Record<string, string> = { controller_payment: "controller payment", dao_motion: "DAO motion", domain: "domain proof" };

/** Badge and the project's own words on the token page. Ours stay ours: this block never replaces the ICPWatch description. */
export function VerifiedProfile({ p, symbol }: { p: Profile & { method: string; verified_at: number }; symbol: string }) {
  return (
    <div class="card card-pad verified-profile">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="ent ent-verified"><span class="ent-name">Verified project</span><span class="ent-mark">&#10003;</span></span>
        <span class="muted" style="font-size:12px">claimed by {METHOD_TEXT[p.method] ?? p.method}, {shortDate(p.verified_at)}</span>
      </div>
      {p.display_name || p.tagline ? <p style="margin:8px 0 0"><b>{p.display_name ?? symbol}</b>{p.tagline ? <>: {p.tagline}</> : null} <span class="muted" style="font-size:12px">(the project's own words)</span></p> : null}
      {p.links.length ? <div class="links" style="margin-top:8px">{p.links.map((l) => <a class="chip link-chip" href={l.url} rel="noopener nofollow"><b>{KIND_TEXT[l.kind]}</b> {l.url.replace(/^https?:\/\/(www\.)?/, "")}</a>)}</div> : null}
    </div>
  );
}

export function ClaimPage({ t, claim, result, editKey, isSns }: { t: TokenRow; claim: Claim | null; result?: { ok: boolean; message: string } | null; editKey?: string | null; isSns: boolean }) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Markets", "/markets"], [`${t.name} (${t.symbol})`, `/token/${t.id}`], ["Claim", null]]} />
      <div class="page-head">
        <div>
          <h1>Claim {t.symbol}</h1>
          <p class="lede">Prove you run this project and get a verified badge plus a profile block on the token page: your name for it, one line in your own words, and links. Claiming changes nothing else: the trust score, the description ICPWatch wrote, and every number stay exactly as they are.</p>
        </div>
      </div>
      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}
      {editKey ? (
        <div class="callout" style="margin-bottom:18px">
          <b>Verified.</b> Your edit key, shown once: <code class="mono" style="word-break:break-all">{editKey}</code>
          <div style="margin-top:6px"><a class="btn btn-primary btn-sm" href={`/token/${t.id}/profile?key=${editKey}`}>Edit the profile</a></div>
        </div>
      ) : null}

      {claim && claim.status === "pending" ? (
        <div class="card card-pad">
          <h2 style="margin-top:0">Pending: {METHOD_TEXT[claim.method]}</h2>
          {claim.method === "controller_payment" ? (
            <div class="prose" style="font-size:13.5px">
              <p>From the default ICP account of controller principal <code class="mono">{claim.subject}</code>, send exactly</p>
              <p style="font-size:22px;font-weight:700;margin:6px 0">{(Number(claim.code) / 1e8).toFixed(8)} ICP</p>
              <p>to</p>
              <p><code class="mono" style="word-break:break-all">{CLAIM_ACCOUNT}</code></p>
              <p>The exact amount is the proof, so no memo is needed. Any wallet works. We check the ICP index every hour, or press the button below after the transfer confirms. The ICP is not returned; it covers the check and nothing more.</p>
            </div>
          ) : claim.method === "dao_motion" ? (
            <div class="prose" style="font-size:13.5px">
              <p>Submit a <b>Motion</b> proposal to the {t.symbol} SNS whose title or summary contains exactly:</p>
              <p><code class="mono">{claim.code}</code></p>
              <p>Once the motion is adopted, the claim verifies at the next hourly check, or when you press the button below.</p>
            </div>
          ) : (
            <div class="prose" style="font-size:13.5px">
              <p>Serve this text at <code class="mono">https://{claim.subject}/.well-known/icpwatch-claim.txt</code>:</p>
              <p><code class="mono">{claim.code}</code></p>
              <p>{claim.subject} qualifies because the ledger or DAO metadata points at it. We fetch the file every hour, or when you press the button below.</p>
            </div>
          )}
          <form method="post" action={`/token/${t.id}/claim/check`} style="margin-top:10px"><input type="hidden" name="claim" value={claim.id} /><button class="btn btn-primary" type="submit">Check now</button> <span class="note">Claim {claim.id}, started {shortDate(claim.created_at)}, valid for 14 days.</span></form>
        </div>
      ) : (
        <form class="card card-pad form" method="post" action={`/token/${t.id}/claim`}>
          <div class="field">
            <label>How will you prove it?</label>
            <div class="checks">
              <label class="check"><input type="radio" name="method" value="controller_payment" checked /><span><b>Controller payment</b>Send an exact tiny ICP amount from a principal that controls the ledger canister. Works from any wallet.</span></label>
              {isSns ? <label class="check"><input type="radio" name="method" value="dao_motion" /><span><b>DAO motion</b>Pass a motion proposal containing a claim code. The DAO itself vouches.</span></label> : null}
              <label class="check"><input type="radio" name="method" value="domain" /><span><b>Domain</b>Serve a claim code from the website the ledger or DAO metadata already points at.</span></label>
            </div>
          </div>
          <div class="field"><label for="subject">Controller principal, or website domain</label><input id="subject" name="subject" type="text" placeholder="principal for a payment claim, domain for a domain claim, blank for a motion" autocomplete="off" spellcheck={false} /></div>
          <div class="field"><label for="contact">Contact (optional)</label><input id="contact" name="contact" type="text" maxlength={120} placeholder="@handle or email" /></div>
          <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
          <button class="btn btn-primary" type="submit">Start claim</button>
        </form>
      )}
      <div class="src" style="margin-top:12px">A newer verified claim replaces the earlier one, so a project that changes hands can re-claim. Claims and profiles are public. Nothing here is a listing fee, and nothing here moves a score.</div>
    </div>
  );
}

export function ProfileEditPage({ t, p, key, result }: { t: TokenRow; p: Profile; key: string; result?: { ok: boolean; message: string } | null }) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Markets", "/markets"], [`${t.name} (${t.symbol})`, `/token/${t.id}`], ["Profile", null]]} />
      <div class="page-head"><div><h1>{t.symbol} project profile</h1><p class="lede">Shown on the token page under a verified badge, marked as your own words. Links you add publish immediately with "verified project" as their source.</p></div></div>
      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}
      <form class="card card-pad form" method="post" action={`/token/${t.id}/profile`}>
        <input type="hidden" name="key" value={key} />
        <div class="field"><label for="display_name">Display name</label><input id="display_name" name="display_name" type="text" maxlength={60} value={p.display_name ?? ""} placeholder={t.name} /></div>
        <div class="field"><label for="tagline">One line about the project</label><input id="tagline" name="tagline" type="text" maxlength={160} value={p.tagline ?? ""} placeholder="What it does, in one sentence" /></div>
        <div class="field">
          <label>Links (up to six)</label>
          {[0, 1, 2, 3, 4, 5].map((i) => <input name="links" type="url" value={p.links[i]?.url ?? ""} placeholder="https://" style="margin-bottom:6px" />)}
        </div>
        <div class="field"><label for="contact">Contact for ICPWatch (not shown)</label><input id="contact" name="contact" type="text" maxlength={120} value={p.contact ?? ""} /></div>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
    </div>
  );
}
