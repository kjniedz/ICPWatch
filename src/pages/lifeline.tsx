import type { CanisterRow, IncidentRow, LifelineSummary } from "../db/queries";
import { ago, fmtCycles, fmtNum, isoDate, now, span } from "../lib/format";
import { Conf, Empty, Fresh, HealthPill } from "../ui/components";

export const roleLabel: Record<string, string> = {
  ledger: "Ledger", index: "Index", archive: "Archive", root: "SNS root", governance: "Governance", swap: "Swap",
  dapp: "Dapp", minter: "Minter", orchestrator: "Orchestrator", other: "Canister",
};

export function runwayCell(c: CanisterRow, nowTs = now()) {
  if (c.health === "life") return <span style="color:var(--life-fg)">preserved</span>;
  if (c.health === "gone") return <span class="down">{c.run_status === "no_wasm" ? "code and state gone" : "deleted"}</span>;
  if (c.health === "frozen") {
    return c.delete_at ? <span style="color:var(--frozen-fg)">{span(c.delete_at - nowTs)} to deletion</span> : <span style="color:var(--frozen-fg)">frozen</span>;
  }
  if (!c.freeze_at) return c.health === "healthy" ? <span>50+ y</span> : <span class="muted">{c.cycles != null ? "measuring" : "n/a"}</span>;
  const left = c.freeze_at - nowTs;
  if (c.health === "low") return <span style="color:var(--low-fg)">{span(left)} to freeze</span>;
  if (c.health === "risk") return <span style="color:var(--risk-fg)">{span(left)} to freeze</span>;
  return <span>~{span(left)}</span>;
}

/** Sort key for runway: smaller is more urgent. Frozen sorts before everything that still runs. */
const runwaySort = (c: CanisterRow, nowTs: number) => {
  if (c.health === "gone") return -2e9;
  if (c.health === "frozen") return -1e9 + (c.delete_at ? c.delete_at - nowTs : 0);
  return c.freeze_at ? c.freeze_at - nowTs : "";
};

const stateAttr = (c: CanisterRow) => {
  const s: string[] = [];
  if (c.health === "low" || c.health === "risk") s.push("risk");
  if (c.health === "frozen" || c.health === "gone") s.push("frozen");
  if (c.health === "life") s.push("life");
  if (c.role === "archive") s.push("archive");
  if (c.confidence === "measured") s.push("measured");
  return s.join(" ");
};

export function healthLabelFor(c: CanisterRow): string | undefined {
  if (c.health === "unknown") return c.cycles != null ? "Measuring" : c.run_status === "running" ? "Responding" : c.run_status === "stopped" ? "Stopped" : "Unknown";
  // Out of cycles long enough to be uninstalled: the canister id still exists, its code and state do not.
  if (c.health === "gone") return c.run_status === "no_wasm" ? "Uninstalled" : "Deleted";
  return undefined;
}

export function CanisterTable({ rows, id = "canisters", showToken = true }: { rows: CanisterRow[]; id?: string; showToken?: boolean }) {
  const nowTs = now();
  return (
    <div class="card tbl-wrap">
      <table class="tbl" id={id} data-sortable>
        <thead>
          <tr>
            <th data-sort="text">Canister</th>
            <th data-sort="text">Type</th>
            <th class="r" data-sort="num">Cycles</th>
            <th class="r" data-sort="num">Burn / day</th>
            <th data-sort="num" aria-sort="ascending">Runway</th>
            <th data-sort="text">Status</th>
            <th data-sort="text">Data</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr data-id={c.id} data-state={stateAttr(c)} data-search={`${c.label} ${c.id} ${c.token_symbol ?? ""} ${c.role}`}>
              <td data-v={c.label.toLowerCase()}>
                <a href={`/canister/${c.id}`} class="name">
                  <span>
                    <span class="t">{c.label}</span>
                    <span class="cid">{c.id}</span>
                  </span>
                </a>
              </td>
              <td data-v={c.role}>
                {roleLabel[c.role] ?? c.role}
                {showToken && c.token_symbol && c.token_id ? <a class="sub muted" href={`/token/${c.token_id}`} style="display:block;font-size:11px">{c.token_symbol}</a> : null}
              </td>
              <td class="r num strong" data-v={c.cycles ?? ""}>{c.cycles != null ? fmtCycles(c.cycles) : <span class="muted">unknown</span>}</td>
              <td class="r num" data-v={c.burn_per_day ?? ""}>
                {c.burn_per_day != null ? fmtCycles(c.burn_per_day) : <span class="muted">n/a</span>}
              </td>
              <td class="nowrap" data-v={runwaySort(c, nowTs)}>{runwayCell(c, nowTs)}</td>
              <td data-v={c.health}><HealthPill health={c.health} label={healthLabelFor(c)} /></td>
              <td data-v={c.confidence}>
                <Conf confidence={c.confidence} source={c.cycles_source} />
                {c.measured_at ? <time class="src" style="display:block" datetime={isoDate(c.measured_at)} data-ago={c.measured_at}>{ago(c.measured_at)}</time> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div data-empty-for={id} hidden={rows.length > 0}>
        <Empty>{rows.length ? "No canisters match this filter." : "The first collection run has not finished yet. Canisters appear here within a few minutes of deploy."}</Empty>
      </div>
    </div>
  );
}

const incidentDot: Record<string, string> = { low_cycles: "risk", frozen: "frozen", approaching_deletion: "frozen", burn_anomaly: "low" };

export function IncidentFeed({ items }: { items: IncidentRow[] }) {
  if (!items.length) {
    return (
      <div class="card">
        <Empty>No incidents yet. When a watched canister runs low, freezes, nears deletion, or its burn spikes against its own baseline, it shows up here once per incident.</Empty>
      </div>
    );
  }
  return (
    <div class="stack">
      {items.map((i) => {
        const resolved = i.state === "resolved";
        return (
          <a class="card feed-item" href={`/canister/${i.canister_id}`}>
            <span class={`d ${resolved ? "ok" : (incidentDot[i.type] ?? "risk")}`} aria-hidden="true"></span>
            <div>
              <h4>{resolved ? `Resolved: ${i.title.replace(/^[^:]+:\s*/, "")}` : i.title}{i.simulated ? <span class="chip" style="margin-left:8px">SIMULATED</span> : null}</h4>
              <p>{i.detail}</p>
              <small>
                <time datetime={isoDate(resolved ? i.resolved_at : i.opened_at)} data-ago={resolved ? i.resolved_at! : i.opened_at}>{ago(resolved ? i.resolved_at : i.opened_at)}</time>
                {" "}&middot; fired once per incident{resolved ? ` · open for ${span((i.resolved_at ?? 0) - i.opened_at)}` : ""}
              </small>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export interface LifeSupportItem { canister_id: string; what: string; story: string | null; since: number; monthly_cycles: number | null; label: string | null; state: string }

export function LifeSupportPanel({ items }: { items: LifeSupportItem[] }) {
  return (
    <>
      {items.length ? (
        <div class="stack">
          {items.map((l) => (
            <div class="card adopt">
              <div class="b">
                <h4><a href={`/canister/${l.canister_id}`}>{l.label ?? l.canister_id}</a></h4>
                <p>{l.what}</p>
                <small>{l.monthly_cycles != null ? `${fmtCycles(l.monthly_cycles)} cycles / mo to preserve` : "cost being measured"} &middot; frozen on purpose</small>
              </div>
              <a class="btn btn-primary btn-sm" href={`/lifeline/life-support?adopt=${l.canister_id}#adopt`}>Adopt</a>
            </div>
          ))}
        </div>
      ) : (
        <div class="card">
          <Empty>
            Nothing is on life support yet. Preservation top-ups are switched off until monitoring data has proven itself.
            Frozen canisters that are candidates show up under the Frozen filter above.
          </Empty>
        </div>
      )}
      <p class="note" style="margin-top:12px">
        Life support tops canisters up just enough to stay above zero and below the freezing threshold. Deletion is prevented at minimum cost, with a global
        spend cap, per-canister budgets, a kill switch, and a full audit log. <a class="link" href="/lifeline/life-support">How it works</a>
      </p>
    </>
  );
}

export function LifelineLive({ summary, rows, incidents, lifeSupport }: { summary: LifelineSummary; rows: CanisterRow[]; incidents: IncidentRow[]; lifeSupport: LifeSupportItem[] }) {
  return (
    <>
      <div data-part="fresh" style="display:flex;justify-content:flex-end;margin:-6px 0 12px">
        <Fresh ts={summary.last_measured_at} source="SNS root + NNS root + ledger metrics + probes" staleAfter={1500} label="refreshed" />
      </div>
      <div class="stats" data-part="stats">
        <div class="card stat">
          <div class="k">Canisters watched</div>
          <div class="v">{fmtNum(summary.watched)}</div>
          <div class="s">incl. {fmtNum(summary.archives)} auto-discovered archives</div>
        </div>
        <div class="card stat">
          <div class="k">At risk right now</div>
          <div class="v c-red">{fmtNum(summary.at_risk + summary.frozen)}</div>
          <div class="s">{fmtNum(summary.at_risk)} low on cycles &middot; {fmtNum(summary.frozen)} frozen</div>
        </div>
        <div class="card stat">
          <div class="k">On life support</div>
          <div class="v c-purple">{fmtNum(summary.life_support)}</div>
          <div class="s">preserved for adoption</div>
        </div>
        <div class="card stat">
          <div class="k">Alerts today</div>
          <div class="v c-amber">{fmtNum(summary.alerts_today)}</div>
          <div class="s">deduped per incident</div>
        </div>
      </div>

      <div class="sec-head">
        <h2>Watched canisters <span class="muted" style="font-weight:500;font-size:12px">&nbsp;<span data-count-for="canisters">{rows.length}</span> shown</span></h2>
        <div class="filters">
          <input class="input" type="search" placeholder="Filter by name, id, token" data-filter-for="canisters" aria-label="Filter canisters" />
          <button class="fpill" data-for="canisters" data-fkey="state" data-fval="all" aria-pressed="true">All</button>
          <button class="fpill" data-for="canisters" data-fkey="state" data-fval="risk" aria-pressed="false">At risk</button>
          <button class="fpill" data-for="canisters" data-fkey="state" data-fval="frozen" aria-pressed="false">Frozen</button>
          <button class="fpill" data-for="canisters" data-fkey="state" data-fval="archive" aria-pressed="false">Archives</button>
          <button class="fpill" data-for="canisters" data-fkey="state" data-fval="life" aria-pressed="false">Life support</button>
        </div>
      </div>
      <div data-part="table"><CanisterTable rows={rows} /></div>
      <p class="note" style="margin-top:10px" data-part="note">
        Data confidence: <Conf confidence="measured" /> read from a controller or the canister itself &nbsp; <Conf confidence="inferred" /> derived from partial data &nbsp;
        <Conf confidence="inferred" source="probe" /> liveness checked by query, balance not readable &nbsp; <Conf confidence="unknown" /> nothing readable yet.
        {" "}{fmtNum(summary.measured)} measured, {fmtNum(summary.inferred)} inferred, {fmtNum(summary.unknown)} unknown.
      </p>

      <div class="grid-2" style="margin-top:8px" data-part="side">
        <section>
          <div class="sec-head"><h2>Alerts</h2><a class="link" href="/lifeline/incidents" style="font-size:12px">All incidents</a></div>
          <IncidentFeed items={incidents} />
        </section>
        <section>
          <div class="sec-head"><h2>On Life Support <span class="tag">adoption registry</span></h2></div>
          <LifeSupportPanel items={lifeSupport} />
        </section>
      </div>
    </>
  );
}

export function LifelinePage(props: { summary: LifelineSummary; rows: CanisterRow[]; incidents: IncidentRow[]; lifeSupport: LifeSupportItem[]; version: string }) {
  return (
    <div class="wrap page">
      <div class="page-head">
        <div>
          <h1>Lifeline <span class="badge-only">Only on ICPWatch</span></h1>
          <p class="lede">Canister health for the whole Internet Computer: cycles, freeze risk, archives, and life support for abandoned canisters.</p>
        </div>
      </div>
      <div data-live="/lifeline/live" data-every="45" data-version={props.version}>
        <LifelineLive {...props} />
      </div>
    </div>
  );
}
