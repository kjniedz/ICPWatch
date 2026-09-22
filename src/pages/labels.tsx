import { ago, isoDate, shortDate } from "../lib/format";
import { isCanisterId } from "../lib/ic";
import { CATEGORIES, CATEGORY_TEXT, type EntityLabel, type LabelDirectory, type LabelSubmission } from "../labels";
import { Crumbs, Empty } from "../ui/components";

const shortId = (id: string) => (id.length > 30 ? `${id.slice(0, 12)}...${id.slice(-6)}` : id);
const hrefFor = (id: string) => (id.startsWith("neuron:") ? `https://dashboard.internetcomputer.org/neuron/${id.slice(7)}` : isCanisterId(id) ? `/canister/${id}` : `/account/${encodeURIComponent(id)}`);

/**
 * A principal or account rendered as a name people recognise. The three confidences look different on
 * purpose: verified (solid check), inferred (dashed, says so), community (chip). No label: a shortened id.
 */
export function EntityName({ id, label, short }: { id: string; label?: EntityLabel | null; short?: boolean }) {
  if (!label) {
    return <a class="mono" href={hrefFor(id)} title={id} style="font-size:12px">{short ? shortId(id) : id}</a>;
  }
  const cls = `ent ent-${label.confidence}`;
  return (
    <a class={cls} href={hrefFor(id)} title={`${id}\n${label.confidence}: ${label.source}`}>
      <span class="ent-name">{label.name}</span>
      {label.confidence === "verified" ? <span class="ent-mark" aria-label="verified">&#10003;</span> : label.confidence === "inferred" ? <span class="ent-tag">inferred</span> : <span class="ent-tag">community</span>}
      {short ? null : <span class="ent-id mono">{shortId(id)}</span>}
    </a>
  );
}

const CONF_TEXT: Record<string, string> = { verified: "Verified: derived from on-chain facts anyone can re-check.", inferred: "Inferred: third-party attribution or a flow heuristic.", community: "Community: submitted by a user and approved by a reviewer." };

export function LabelsPage({ dir, q, category, confidence }: { dir: LabelDirectory; q: string; category: string; confidence: string }) {
  return (
    <div class="wrap page" style="max-width:1000px">
      <Crumbs items={[["Network", "/network"], ["Labels", null]]} />
      <div class="page-head">
        <div>
          <h1>Entity labels</h1>
          <p class="lede">Who is behind a principal or account: SNS governance and treasuries, minters, DEX pools, known neurons, system canisters. Every label shows its evidence and confidence.</p>
        </div>
        <a class="btn btn-primary btn-sm" href="/labels/submit">Suggest a label</a>
      </div>
      <form class="card card-pad filters" method="get" action="/labels" style="margin-bottom:16px">
        <input class="input" type="search" name="q" value={q} placeholder="Name or id" aria-label="Search labels" />
        <select class="input" name="category">
          <option value="">Any category</option>
          {CATEGORIES.map((c) => <option value={c} selected={c === category}>{CATEGORY_TEXT[c]}</option>)}
        </select>
        <select class="input" name="confidence">
          <option value="">Any confidence</option>
          {["verified", "inferred", "community"].map((c) => <option value={c} selected={c === confidence}>{c}</option>)}
        </select>
        <button class="btn btn-primary btn-sm" type="submit">Filter</button>
      </form>
      <p class="note" style="margin-bottom:14px">
        {dir.total.toLocaleString("en-US")} labels{dir.shown < dir.total ? `, ${dir.shown} shown` : ""}. <EntityName id="x" label={{ id: "x", name: "Verified", category: "other", confidence: "verified", source: CONF_TEXT.verified!, token_id: null, url: null, updated_at: 0 }} short />{" "}
        <EntityName id="y" label={{ id: "y", name: "Inferred", category: "other", confidence: "inferred", source: CONF_TEXT.inferred!, token_id: null, url: null, updated_at: 0 }} short />{" "}
        <EntityName id="z" label={{ id: "z", name: "Community", category: "other", confidence: "community", source: CONF_TEXT.community!, token_id: null, url: null, updated_at: 0 }} short />
      </p>
      {dir.groups.map((g) => (
        <section>
          <div class="sec-head"><h2>{CATEGORY_TEXT[g.category]} <span class="muted" style="font-weight:500;font-size:12px">{g.labels.length}</span></h2></div>
          <div class="card tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Name</th><th>Id</th><th class="hide-m">Evidence</th><th>Updated</th></tr></thead>
              <tbody>
                {g.labels.map((l) => (
                  <tr>
                    <td><EntityName id={l.id} label={l} short /></td>
                    <td class="mono" style="font-size:11px;word-break:break-all">{l.id}</td>
                    <td class="hide-m" style="font-size:12px;color:var(--text-2);max-width:420px">{l.source}{l.url ? <> <a class="link" href={l.url} rel="noopener nofollow">link</a></> : null}</td>
                    <td><time datetime={isoDate(l.updated_at)} data-ago={l.updated_at}>{ago(l.updated_at)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {dir.groups.length ? null : <div class="card"><Empty>No labels match.</Empty></div>}
    </div>
  );
}

export function LabelSubmitPage({ target, result }: { target: string; result?: { ok: boolean; message: string } | null }) {
  return (
    <div class="wrap page narrow">
      <Crumbs items={[["Labels", "/labels"], ["Suggest a label", null]]} />
      <div class="page-head"><div><h1>Suggest a label</h1><p class="lede">Know who is behind an account? Point us at public evidence. A reviewer checks it before anything goes live, and approved labels are marked "community" so readers know how they were sourced.</p></div></div>
      {result ? <div class={`callout${result.ok ? "" : " warn"}`} style="margin-bottom:18px" role="status">{result.message}</div> : null}
      <form class="card card-pad form" method="post" action="/labels/submit">
        <div class="field"><label for="target">Principal, ICRC-1 account, or ICP account identifier</label><input id="target" name="target" type="text" required value={target} spellcheck={false} autocomplete="off" /></div>
        <div class="field"><label for="name">Name</label><input id="name" name="name" type="text" required maxlength={80} placeholder="Binance hot wallet, Project X team multisig, ..." /></div>
        <div class="field">
          <label for="category">Category</label>
          <select id="category" name="category" class="input" style="width:100%">{CATEGORIES.map((c) => <option value={c}>{CATEGORY_TEXT[c]}</option>)}</select>
        </div>
        <div class="field"><label for="evidence">Evidence (https link)</label><input id="evidence" name="evidence" type="url" required placeholder="https://" /><div class="hint">A page where the owner names this account: proof of reserves, an official docs page, a signed announcement. Screenshots and other explorers' labels do not count.</div></div>
        <div class="field"><label for="note">Note (optional)</label><textarea id="note" name="note" maxlength={500}></textarea></div>
        <div class="field"><label for="contact">Your contact (optional)</label><input id="contact" name="contact" type="text" maxlength={120} placeholder="email or handle, only used if the reviewer has a question" /></div>
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input type="text" name="website" tabindex={-1} autocomplete="off" /></label></div>
        <div><button class="btn btn-primary" type="submit">Submit for review</button></div>
      </form>
    </div>
  );
}

export function SubmissionsAdmin({ items }: { items: LabelSubmission[] }) {
  return (
    <div class="wrap page" style="max-width:1000px">
      <div class="page-head"><div><h1>Label review queue</h1><p class="lede">{items.length} pending. Flow candidates come from the large-transfer heuristic and carry their evidence as JSON.</p></div></div>
      <div class="stack">
        {items.map((s) => (
          <div class="card card-pad">
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div><b>{s.name}</b> <span class="chip">{s.category}</span> <span class="chip">{s.origin}</span><div class="mono" style="font-size:11px;margin-top:4px">{s.target_id}</div></div>
              <span class="muted" style="font-size:12px">{shortDate(s.created_at)}</span>
            </div>
            {s.evidence_url ? <div style="margin-top:8px;font-size:12.5px"><a class="link" href={s.evidence_url} rel="noopener nofollow">{s.evidence_url}</a></div> : null}
            {s.note ? <pre style="margin-top:8px;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--text-2)">{s.note}</pre> : null}
            {s.submitter_contact ? <div class="muted" style="font-size:12px;margin-top:4px">contact: {s.submitter_contact}</div> : null}
            <form method="post" action="/admin/labels/review" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
              <input type="hidden" name="id" value={String(s.id)} />
              <input class="input" name="note" placeholder="reviewer note" style="flex:1;min-width:200px" />
              <button class="btn btn-primary btn-sm" name="decision" value="approve" type="submit">Approve</button>
              <button class="btn btn-ghost btn-sm" name="decision" value="reject" type="submit">Reject</button>
            </form>
          </div>
        ))}
        {items.length ? null : <div class="card"><Empty>Nothing pending.</Empty></div>}
      </div>
    </div>
  );
}
