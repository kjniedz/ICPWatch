// Canister change history: pure helpers shared by the collector, the timeline component, and alerts.
// No network and no bindings in here, so everything is unit tested.

export type HistoryKind = "creation" | "install" | "reinstall" | "upgrade" | "uninstall" | "controllers_change" | "snapshot" | "other";

export interface HistoryEntry {
  canister_id: string;
  canister_version: number;
  /** Unix seconds. */
  ts: number;
  kind: HistoryKind;
  /** Hex. Set for install, reinstall, and upgrade. */
  module_hash: string | null;
  /** Set for creation and controllers_change. */
  controllers: string[] | null;
  /** "user:<principal>" or "canister:<canister id>". */
  origin: string | null;
}

/** A canister_history row as stored in D1: controllers is a json string. */
export interface HistoryRow extends Omit<HistoryEntry, "controllers"> { controllers: string | null }

export interface KnownState { moduleHash: string | null; controllers: string[] | null }

export type SecurityEventType = "controller_change" | "module_change";

export interface SecurityEvent {
  type: SecurityEventType;
  canister_id: string;
  canister_version: number;
  ts: number;
  kind: HistoryKind;
  origin: string | null;
  title: string;
  detail: string;
  old_module_hash?: string | null;
  new_module_hash?: string | null;
  added?: string[];
  removed?: string[];
}

export function diffControllers(prev: string[] | null | undefined, next: string[] | null | undefined): { added: string[]; removed: string[] } {
  const a = new Set(prev ?? []);
  const b = new Set(next ?? []);
  return { added: [...b].filter((p) => !a.has(p)), removed: [...a].filter((p) => !b.has(p)) };
}

export const shortHash = (h: string | null | undefined): string => (h ? `${h.slice(0, 10)}...${h.slice(-6)}` : "none");

/** "user:abc" becomes { type: "user", id: "abc" }. */
export function parseOrigin(origin: string | null | undefined): { type: "user" | "canister"; id: string } | null {
  const m = /^(user|canister):(.+)$/.exec(origin ?? "");
  return m ? { type: m[1] as "user" | "canister", id: m[2]! } : null;
}

const who = (origin: string | null) => {
  const o = parseOrigin(origin);
  return o ? `${o.type === "canister" ? "canister" : "principal"} ${o.id}` : "an unknown caller";
};

const asc = <T extends { canister_version: number }>(list: T[]): T[] => [...list].sort((x, y) => x.canister_version - y.canister_version);

/**
 * Security events for alerting. `prev` is the state known before these changes (from the previous
 * canister_info read). With no previous state there is no baseline, so the first backfill of a
 * canister's history never fires: the result is empty. Changes are replayed in version order, so
 * a controller that was added and removed again between two reads produces both events.
 * A redeploy of the same wasm and a controllers_change that leaves the set unchanged are not events.
 */
export function securityEvents(prev: KnownState | null, changes: HistoryEntry[]): SecurityEvent[] {
  if (!prev) return [];
  const out: SecurityEvent[] = [];
  let moduleHash = prev.moduleHash;
  let controllers = prev.controllers;
  for (const ch of asc(changes)) {
    const base = { canister_id: ch.canister_id, canister_version: ch.canister_version, ts: ch.ts, kind: ch.kind, origin: ch.origin };
    if (ch.kind === "install" || ch.kind === "reinstall" || ch.kind === "upgrade" || ch.kind === "uninstall") {
      const next = ch.kind === "uninstall" ? null : ch.module_hash;
      if (next !== moduleHash) {
        out.push({
          ...base, type: "module_change", old_module_hash: moduleHash, new_module_hash: next,
          title: ch.kind === "uninstall" ? "Code uninstalled" : ch.kind === "upgrade" ? "Module upgraded" : ch.kind === "reinstall" ? "Module reinstalled (state wiped)" : "Module installed",
          detail: `Module hash went from ${shortHash(moduleHash)} to ${shortHash(next)}, by ${who(ch.origin)}.`,
        });
      }
      moduleHash = next;
    } else if (ch.kind === "controllers_change" || ch.kind === "creation") {
      const { added, removed } = diffControllers(controllers, ch.controllers);
      if (controllers != null && (added.length || removed.length)) {
        const parts = [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean);
        out.push({
          ...base, type: "controller_change", added, removed,
          title: (ch.controllers ?? []).length === 0 ? "Controllers removed: canister is now immutable" : "Controllers changed",
          detail: `Controllers ${parts.join(" and ")}, by ${who(ch.origin)}.`,
        });
      }
      controllers = ch.controllers ?? controllers;
    } else if (ch.kind === "snapshot") {
      // Loading a snapshot can replace the module. The hash is not part of the change record, so
      // the baseline is unknown until the next deployment.
      moduleHash = null;
    }
  }
  return out;
}

export interface TimelineItem {
  canister_version: number;
  ts: number;
  kind: HistoryKind;
  title: string;
  origin: { type: "user" | "canister"; id: string } | null;
  /** Module hash before and after, for code changes. `old_module_hash` is undefined when no earlier deployment is on record. */
  old_module_hash?: string | null;
  new_module_hash?: string | null;
  /** Full controller set after the change, plus the diff against the previous entry when there is one. */
  controllers?: string[];
  added?: string[];
  removed?: string[];
  /** True when the previous controller set is on record, so added and removed are meaningful. */
  diffed?: boolean;
}

const parseList = (s: string | null): string[] | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
};

const TITLES: Record<HistoryKind, string> = {
  creation: "Canister created", install: "Code installed", reinstall: "Code reinstalled (state wiped)", upgrade: "Module upgraded",
  uninstall: "Code uninstalled", controllers_change: "Controllers changed", snapshot: "Snapshot loaded", other: "Other change",
};

/** Rows in any order in, readable timeline out, newest first. Each entry is compared with the one before it. */
export function timeline(rows: HistoryRow[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let moduleHash: string | null | undefined;
  let controllers: string[] | null = null;
  for (const r of asc(rows)) {
    const item: TimelineItem = { canister_version: r.canister_version, ts: r.ts, kind: r.kind, title: TITLES[r.kind] ?? TITLES.other, origin: parseOrigin(r.origin) };
    if (r.kind === "install" || r.kind === "reinstall" || r.kind === "upgrade" || r.kind === "uninstall") {
      item.old_module_hash = moduleHash;
      item.new_module_hash = r.kind === "uninstall" ? null : r.module_hash;
      if (r.kind === "upgrade" && moduleHash != null && moduleHash === r.module_hash) item.title = "Upgraded with the same module";
      moduleHash = item.new_module_hash;
    } else if (r.kind === "creation" || r.kind === "controllers_change") {
      const next = parseList(r.controllers) ?? [];
      item.controllers = next;
      if (r.kind === "controllers_change") {
        item.diffed = controllers != null;
        const d = diffControllers(controllers, next);
        item.added = d.added;
        item.removed = d.removed;
        if (!next.length) item.title = "Controllers removed: canister made immutable";
      }
      controllers = next;
    } else if (r.kind === "snapshot") {
      moduleHash = undefined;
    }
    out.push(item);
  }
  return out.reverse();
}
