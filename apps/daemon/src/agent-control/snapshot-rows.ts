import {
  MonitoredChild,
  maxMonitoredChildren,
  type MonitorSnapshot,
  type MonitoredState,
  type ThreadId,
} from "@ace/protocol";
import type { z } from "zod";

/* How agents_status turns per-child facts into one listing. Pure. */

/** What is known about a child without reading its facts: enough for a row. */
export interface ChildIdentity {
  id: ThreadId;
  role: string;
  parent?: ThreadId | undefined;
  machine?: string | undefined;
}

/** A row read leniently, and what failed, for the log. */
export interface CheckedChild {
  child: MonitoredChild;
  problem?: string;
}

const clipped = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

function identityRow(identity: ChildIdentity): MonitoredChild {
  return {
    id: identity.id,
    ...(identity.parent ? { parent: identity.parent } : {}),
    role: clipped(identity.role, 40),
    state: "unknown",
    elapsedSeconds: 0,
    ...(identity.machine ? { machine: clipped(identity.machine, 64) } : {}),
  };
}

/** Field paths and codes only: schema names are ace's own, values never reach the text. */
export function issueSummary(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 4)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
}

/** A child whose facts could not be read at all: listed, never settled. */
export function unreadableChild(identity: ChildIdentity, error: unknown): CheckedChild {
  const reason = error instanceof Error ? error.message : String(error);
  return { child: identityRow(identity), problem: clipped(reason, 300) };
}

/**
 * The row as built, when it fits the schema. Otherwise the fields that do fit, over the child's
 * identity; a state that doesn't fit reads `unknown`.
 */
export function checkedChild(identity: ChildIdentity, row: unknown): CheckedChild {
  const parsed = MonitoredChild.safeParse(row);
  if (parsed.success) return { child: parsed.data };
  const kept: Record<string, unknown> = { ...identityRow(identity) };
  const fields = new Map(row && typeof row === "object" ? Object.entries(row) : []);
  for (const [key, field] of Object.entries(MonitoredChild.shape)) {
    if (!fields.has(key)) continue;
    const value = field.safeParse(fields.get(key));
    if (value.success && value.data !== undefined) kept[key] = value.data;
  }
  return {
    child: MonitoredChild.parse(kept),
    problem: issueSummary(parsed.error.issues),
  };
}

/** Lower first: children still working or waiting lead, so a full list never hides them. */
const rank: Record<MonitoredState, number> = {
  needs_you: 0,
  unknown: 1,
  working: 2,
  queued: 3,
  failed: 4,
  cancelled: 5,
  done: 6,
};

/** Counts the whole tree, then lists as many children as fit, unsettled first. */
export function snapshotOf(rows: readonly MonitoredChild[]): MonitorSnapshot {
  const counts: MonitorSnapshot["counts"] = {
    working: 0,
    queued: 0,
    needs_you: 0,
    unknown: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows) counts[row.state]++;
  const children = rows
    .map((row, index) => ({ row, index }))
    .toSorted((a, b) => rank[a.row.state] - rank[b.row.state] || a.index - b.index)
    .slice(0, maxMonitoredChildren)
    .map((entry) => entry.row);
  const omitted = rows.length - children.length;
  return { children, ...(omitted > 0 ? { omitted } : {}), counts };
}
