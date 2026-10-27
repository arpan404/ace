import { inboxGroupRank, type InboxGroupKey, type InboxSection } from "@ace/ui-core/mobile";
import type { StartupRoute } from "../runtime/production-startup.ts";
import { shouldShowInbox } from "./production-inbox.ts";

/**
 * Multi-machine merged production inbox: pure merge and host-aware
 * navigation over the existing production read leases.
 *
 * Mirrors the iOS `MachineInbox.merged` + `InboxRoute.thread(InboxKey)`
 * boundary without copying it: each machine's threads are grouped on their
 * own runtime (shared `inboxSections` rules, per-machine sections), and this
 * module only orders sections by the shared group order and rows by rank. It
 * never decides a group or a status. Rank comparison is plain string `<`
 * (UTF-16 code units), the same order the shared ranks are built for.
 *
 * No networking, no storage and no secrets. Leases stay behind
 * `startup.runtimeForReading(hostId)`; this module only decides which rows
 * show, in what order, and which machine a thread opens on. Mutations never
 * pass through here.
 */

/** One open thread: the row's machine plus the thread, like iOS `InboxKey`. */
export interface ProductionOpenKey {
  readonly machineId: string;
  readonly id: string;
}

/** Row key, namespaced apart like the single-machine inbox (`host:id`). */
export function mergedKeyFor(machineId: string, id: string): string {
  return `${machineId}:${id}`;
}

/**
 * Stable string identity for an open thread (host newline id, as iOS scene
 * storage keeps it). The newline never appears in either half, so unlike the
 * display key above it round-trips even past a colon in either half.
 */
export function openKeyString(key: ProductionOpenKey): string {
  return `${key.machineId}\n${key.id}`;
}

/** Inverse of `openKeyString`; undefined for anything not from it. */
export function parseOpenKey(place: string): ProductionOpenKey | undefined {
  const parts = place.split("\n");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { machineId: parts[0], id: parts[1] };
}

export interface MergedInboxRow {
  readonly machineId: string;
  readonly id: string;
  readonly key: string;
  readonly rank: string;
}

export interface MergedInboxSection {
  readonly key: InboxGroupKey;
  readonly label: string;
  readonly rows: readonly MergedInboxRow[];
  /**
   * How many threads the section holds, loaded or not: each machine's
   * section counts what the daemon pages beyond its loaded window, so the
   * merged total adds those extras to the loaded rows.
   */
  readonly total: number;
}

export type ProductionMergedEntry =
  | { kind: "heading"; id: string; title: string }
  | { kind: "thread"; id: string; key: string; machineId: string };

/**
 * Merge per-machine sections into one inbox. Sections join by group key in
 * the shared group order; rows sort by rank. The same thread id on two hosts
 * keeps two rows because keys carry their machine. A machine whose lease is
 * dead contributes no sections, so its trouble never touches another
 * machine's rows.
 */
export function mergeInboxSections(
  perMachine: readonly {
    readonly machineId: string;
    readonly sections: readonly InboxSection[];
  }[],
): MergedInboxSection[] {
  const groups = new Map<InboxGroupKey, { label: string; rows: MergedInboxRow[]; extra: number }>();
  for (const part of perMachine) {
    for (const section of part.sections) {
      let group = groups.get(section.key);
      if (group === undefined) {
        group = { label: section.label, rows: [], extra: 0 };
        groups.set(section.key, group);
      }
      section.keys.forEach((key, index) => {
        const id = key.startsWith(`${part.machineId}:`)
          ? key.slice(part.machineId.length + 1)
          : key;
        group.rows.push({
          machineId: part.machineId,
          id,
          key: mergedKeyFor(part.machineId, id),
          rank: section.ranks[index] ?? "",
        });
      });
      const extra = Math.max(0, section.total - section.keys.length);
      group.extra += extra;
    }
  }
  return [...groups.entries()]
    .toSorted(([a], [b]) => inboxGroupRank(a) - inboxGroupRank(b))
    .map(([key, group]) => ({
      key,
      label: group.label,
      rows: group.rows.toSorted((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)),
      total: group.rows.length + group.extra,
    }));
}

/** Grouped rows for the merged list, mirroring the single-machine entries. */
export function mergedEntriesFor(merged: readonly MergedInboxSection[]): ProductionMergedEntry[] {
  const rows: ProductionMergedEntry[] = [];
  for (const section of merged) {
    if (section.rows.length === 0 && section.total === 0) continue;
    rows.push({ kind: "heading", id: `heading:${section.key}`, title: section.label });
    for (const row of section.rows) {
      rows.push({ kind: "thread", id: row.id, key: row.key, machineId: row.machineId });
    }
  }
  return rows;
}

/** Machine names show on rows only when there is more than one machine. */
export function showsMachineNames(machineCount: number): boolean {
  return machineCount > 1;
}

/** Display name for a row's machine mark; the host id when unnamed. */
export function machineLabelFor(hostId: string, names: Readonly<Record<string, string>>): string {
  return names[hostId] ?? hostId;
}

/** True when the route permits resolving (and retaining) a read lease. */
export function shouldResolveLeaseFor(route: StartupRoute): boolean {
  return shouldShowInbox(route);
}

/** Hosts whose route permits an inbox lease right now. */
export function pairedHostsFor(
  hostIds: readonly string[],
  routeOf: (hostId: string) => StartupRoute,
): string[] {
  return hostIds.filter((hostId) => shouldShowInbox(routeOf(hostId)));
}

/**
 * Host-aware open-thread resolution, synchronous during render. An open
 * thread belongs to its machine: switching machines, removing its machine,
 * or revoking its route closes it, while other machines' rows and threads
 * are untouched.
 */
export function resolveOpenKeyForHosts(
  openKey: ProductionOpenKey | null,
  availableHostIds: readonly string[],
): ProductionOpenKey | null {
  if (openKey === null) return null;
  return availableHostIds.includes(openKey.machineId) ? openKey : null;
}

/** Route-gated open thread: a revoked/pin route must never keep its thread. */
export function openKeyForRoutes(
  openKey: ProductionOpenKey | null,
  routeOf: (hostId: string) => StartupRoute,
): ProductionOpenKey | null {
  if (openKey === null) return null;
  return shouldShowInbox(routeOf(openKey.machineId)) ? openKey : null;
}
