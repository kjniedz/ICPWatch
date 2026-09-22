// Token links and description on the token page, the public "suggest a link" form, and the admin queue.
import { KIND_TEXT, LINK_KINDS, type LinkKind, type TokenLink } from "../meta";
import { shortDate } from "../lib/format";
import { Crumbs, Empty } from "../ui/components";

const SOURCE_TEXT: Record<string, string> = {
  icrc1_metadata: "ledger metadata (on chain)", sns_metadata: "SNS metadata (on chain)", seed: "ICPWatch registry", icpwatch: "ICPWatch", coingecko: "CoinGecko", listing: "listing",
};
const sourceText = (s: string) => (s.startsWith("submission:") ? "community submission" : SOURCE_TEXT[s] ?? s);
const host = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/** About block: our description with its provenance, then every published link with its sources. */
export function AboutSection({ tokenId, symbol, description, links, fallback }: {
  tokenId: string; symbol: string; description: { text: string; source: string; updated_at: number } | null; links: TokenLink[]; fallback: { description: string | null; url: string | null };
}) {
  const text = description?.text ?? fallback.description;
  if (!text && !links.length) return null;
  return (
    <>
      <div class="sec-head" id="about"><h2>About {symbol}</h2>{description ? <span class="note">{description.source === "icpwatch" ? "Written by ICPWatch" : "From on-chain facts"}, {shortDate(description.updated_at)}</span> : null}</div>
      <div class="card card-pad" style="color:var(--text-2)">
        {text ? <p style="margin:0 0 10px">{text}</p> : null}
        {links.length ? (
          <div class="links">
            {links.map((l) => (
              <a class="chip link-chip" href={l.url} rel="noopener nofollow" title={`${l.url}\nSource: ${l.sources.map(sourceText).join(", ")}`}>
                <b>{KIND_TEXT[l.kind]}</b> {l.kind === "twitter" ? `@${l.url.split("/").pop()}` : l.kind === "telegram" ? `t.me/${l.url.split("/").pop()}` : host(l.url)}
                {l.sources.some((s) => s === "icrc1_metadata" || s === "sns_metadata") ? <span class="ent-mark" title="Stated on chain">&#10003;</span> : null}
              </a>
            ))}
          </div>
        ) : null}
        <div class="src" style="margin-top:10px">
          Links are published only when the ledger or DAO states them on chain, or two independent sources agree. <a class="link" href={`/token/${tokenId}/links`}>Suggest a link</a>.
        </div>
      </div>
    </>
  );
}

export function LinkSubmitPage({ tokenId, symbol, name, result }: { tokenId: string; symbol: string; name: string; result?: { ok: boolean; message: string } | null }) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Markets", "/markets"], [`${name} (${symbol})`, `/token/${tokenId}`], ["Suggest a link", null]]} />
      <div class="page-head"><div><h1>Suggest a link for {symbol}</h1><p class="lede">Official website, docs, X, Telegram, Discord, or GitHub. A reviewer checks it against a second source before it shows on the token page.</p></div></div>
      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}
      <form class="card card-pad form" method="post" action={`/token/${tokenId}/links`}>
        <div class="field"><label for="url">Link</label><input id="url" name="url" type="url" required placeholder="https://" autocomplete="off" /></div>
        <div class="field"><label for="note">Where is it confirmed? (optional)</label><input id="note" name="note" type="text" maxlength={300} placeholder="Linked from the DAO's governance metadata, pinned in the official Telegram, ..." /></div>
        <div class="field"><label for="contact">Contact (optional)</label><input id="contact" name="contact" type="text" maxlength={120} placeholder="@handle or email, only used if we have a question" /></div>
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
        <button class="btn btn-primary" type="submit">Submit for review</button>
      </form>
    </div>
  );
}

export function LinksAdmin({ items, status, token }: { items: (TokenLink & { symbol: string; name: string })[]; status: string; token: string }) {
  return (
    <div class="wrap page" style="max-width:1000px">
      <div class="page-head"><div><h1>Link review queue</h1><p class="lede">{items.length} {status}. Single-source links wait here. Approve only after you have seen the link confirmed somewhere the project controls.</p></div>
        <div class="page-actions">{["pending", "published", "rejected"].map((s) => <a class="fpill" href={`/admin/meta/links?token=${token}&status=${s}`} aria-pressed={String(s === status)}>{s}</a>)}</div></div>
      <div class="stack">
        {items.map((l) => (
          <div class="card card-pad">
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div><b>{l.symbol}</b> <span class="muted">{l.name}</span> <span class="chip">{KIND_TEXT[l.kind]}</span>
                <div style="margin-top:4px"><a class="link" href={l.url} rel="noopener nofollow">{l.url}</a></div>
                <div class="muted" style="font-size:12px;margin-top:4px">sources: {l.sources.map(sourceText).join(", ")}{l.note ? ` · ${l.note}` : ""}</div></div>
              <span class="muted" style="font-size:12px">{shortDate(l.updated_at)}</span>
            </div>
            <form method="post" action="/admin/meta/review" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
              <input type="hidden" name="token_id" value={l.token_id} /><input type="hidden" name="url" value={l.url} /><input type="hidden" name="token" value={token} />
              <select class="input" name="kind">{LINK_KINDS.map((k) => <option value={k} selected={k === l.kind}>{KIND_TEXT[k as LinkKind]}</option>)}</select>
              <input class="input" name="note" placeholder="reviewer note" style="flex:1;min-width:200px" />
              <button class="btn btn-primary btn-sm" name="decision" value="approve" type="submit">Publish</button>
              <button class="btn btn-ghost btn-sm" name="decision" value="reject" type="submit">Reject</button>
            </form>
          </div>
        ))}
        {items.length ? null : <div class="card"><Empty>Nothing {status}.</Empty></div>}
      </div>
    </div>
  );
}
