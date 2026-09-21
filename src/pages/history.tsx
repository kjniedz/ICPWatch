// "Upgrade and controller history" block for the canister page: a readable timeline built from
// canister_history (the IC's own change log, accumulated by the history collector). Falls back to the
// older canister_changes rows (diffs observed by ICPWatch) while a canister has not been backfilled yet.
import type { CanisterHistory } from "../collectors/history";
import { isoDate, shortDate, shortId } from "../lib/format";
import { shortHash, timeline, type TimelineItem } from "../lib/history";
import { Empty, Fresh } from "../ui/components";

interface ObservedChange { ts: number; field: string; old_value: string | null; new_value: string | null }

const DOT: Partial<Record<TimelineItem["kind"], string>> = { controllers_change: "d risk", reinstall: "d risk", uninstall: "d frozen", snapshot: "d low" };

function Who({ o }: { o: TimelineItem["origin"] }) {
  if (!o) return <>by an unknown caller</>;
  return <>by {o.type === "canister" ? "canister" : "principal"} <a class="mono" href={o.type === "canister" ? `/canister/${o.id}` : `/account/${o.id}`} title={o.id}>{shortId(o.id)}</a></>;
}

const PrincipalLine = ({ sign, p }: { sign: "+" | "-" | ""; p: string }) => (
  <div class={`mono ${sign === "+" ? "up" : sign === "-" ? "down" : ""}`} style="font-size:11px;word-break:break-all">{sign ? `${sign} ` : ""}<a href={`/search?q=${p}`}>{p}</a></div>
);

function Item({ t }: { t: TimelineItem }) {
  const code = t.kind === "install" || t.kind === "reinstall" || t.kind === "upgrade" || t.kind === "uninstall";
  return (
    <div class="card feed-item">
      <span class={DOT[t.kind] ?? "d ok"}></span>
      <div style="min-width:0">
        <h4>{t.title}</h4>
        {code ? (
          <p class="mono" style="font-size:11px;word-break:break-all">
            <span title={t.old_module_hash ?? undefined}>{t.old_module_hash === undefined ? "earlier module not on record" : shortHash(t.old_module_hash)}</span> &rarr;{" "}
            <span title={t.new_module_hash ?? undefined}>{shortHash(t.new_module_hash)}</span>
          </p>
        ) : null}
        {t.kind === "controllers_change" && t.diffed && (t.added?.length || t.removed?.length) ? (
          <>
            {t.added!.map((p) => <PrincipalLine sign="+" p={p} />)}
            {t.removed!.map((p) => <PrincipalLine sign="-" p={p} />)}
          </>
        ) : null}
        {t.kind === "controllers_change" && t.diffed && !t.added?.length && !t.removed?.length ? <p style="font-size:12px">Same controller set as before.</p> : null}
        {(t.kind === "creation" || (t.kind === "controllers_change" && !t.diffed)) && t.controllers ? (
          t.controllers.length ? <>{t.controllers.map((p) => <PrincipalLine sign="" p={p} />)}</> : <p style="font-size:12px">No controllers.</p>
        ) : null}
        {t.kind === "other" ? <p style="font-size:12px">A change type ICPWatch does not decode yet.</p> : null}
        <small><time datetime={isoDate(t.ts)}>{shortDate(t.ts)}</time> &middot; <Who o={t.origin} /> &middot; version {t.canister_version.toLocaleString("en-US")}</small>
      </div>
    </div>
  );
}

/**
 * Drop-in replacement for the "Upgrade and controller history" section on the canister page.
 * Renders its own section heading. `changes` is the existing canister_changes list, used only
 * until the history collector has reached this canister.
 */
export function HistoryTimeline({ history, changes = [], discoveredAt }: { history: CanisterHistory | null; changes?: ObservedChange[]; discoveredAt?: number | null }) {
  const items = history ? timeline(history.rows) : [];
  const missing = history?.total_changes != null ? Math.max(0, history.total_changes - items.length) : 0;
  return (
    <>
      <div class="sec-head">
        <h2>Upgrade and controller history</h2>
        {history?.checked_at ? <Fresh ts={history.checked_at} source="management canister canister_info" staleAfter={86400} label="checked" /> : null}
      </div>
      {items.length ? (
        <div class="stack">
          {items.map((t) => <Item t={t} />)}
          {missing > 0 ? (
            <div class="src">
              The IC reports {history!.total_changes!.toLocaleString("en-US")} changes in total and keeps only the latest 20. {missing.toLocaleString("en-US")} earlier one{missing === 1 ? "" : "s"} happened before ICPWatch started recording.
            </div>
          ) : null}
        </div>
      ) : changes.length ? (
        <div class="stack">
          {changes.map((ch) => (
            <div class="card feed-item">
              <span class="d ok"></span>
              <div style="min-width:0">
                <h4>{ch.field === "module_hash" ? "Module upgraded" : "Controllers changed"}</h4>
                <p class="mono" style="font-size:11px;word-break:break-all">{(ch.old_value ?? "none").slice(0, 80)} &rarr; {(ch.new_value ?? "none").slice(0, 80)}</p>
                <small><time datetime={isoDate(ch.ts)}>{shortDate(ch.ts)}</time> &middot; observed by ICPWatch</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div class="card"><Empty>{history?.checked_at ? "The IC has no recorded changes for this canister." : `History has not been read for this canister yet${discoveredAt ? `. ICPWatch has watched it since ${shortDate(discoveredAt)}` : ""}.`}</Empty></div>
      )}
    </>
  );
}
