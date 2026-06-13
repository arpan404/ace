import type {
  TimelineCompletedWorkDetailRow,
  TimelineMetaGroupEntry,
  TimelineRow,
  TimelineWorkEntry,
  TimelineWorkLogRow,
} from "./timelineRows";

export type TimelineDisclosureKind =
  | "command-output"
  | "completed-work-detail-group"
  | "completed-work-summary"
  | "work-detail"
  | "work-group";

export type TimelineDisclosureKey = `${TimelineDisclosureKind}:${string}`;

export type TimelineDisclosureExpansionState = Readonly<Record<string, boolean>>;

const DISCLOSURE_PREFIXES: readonly `${TimelineDisclosureKind}:`[] = [
  "command-output:",
  "completed-work-detail-group:",
  "completed-work-summary:",
  "work-detail:",
  "work-group:",
];

function stripTimelineDisclosurePrefix(id: string): string {
  for (const prefix of DISCLOSURE_PREFIXES) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }
  return id;
}

function simpleTimelineDisclosureKey(
  kind: Exclude<TimelineDisclosureKind, "completed-work-detail-group">,
  id: string,
): TimelineDisclosureKey {
  const prefix = `${kind}:` as const;
  return id.startsWith(prefix) ? (id as TimelineDisclosureKey) : `${prefix}${id}`;
}

export function commandOutputDisclosureKey(workEntryId: string): TimelineDisclosureKey {
  return simpleTimelineDisclosureKey("command-output", workEntryId);
}

export function completedWorkSummaryDisclosureKey(rowId: string): TimelineDisclosureKey {
  return simpleTimelineDisclosureKey("completed-work-summary", rowId);
}

export function completedWorkDetailGroupDisclosureKey(
  completedWorkSummaryId: string,
  detailRowId: string,
): TimelineDisclosureKey {
  return `completed-work-detail-group:${stripTimelineDisclosurePrefix(
    completedWorkSummaryId,
  )}:${stripTimelineDisclosurePrefix(detailRowId)}`;
}

export function workDetailDisclosureKey(workEntryId: string): TimelineDisclosureKey {
  return simpleTimelineDisclosureKey("work-detail", workEntryId);
}

export function workGroupDisclosureKey(rowId: string): TimelineDisclosureKey {
  return simpleTimelineDisclosureKey("work-group", rowId);
}

export function isTimelineDisclosureExpanded(
  state: TimelineDisclosureExpansionState,
  key: TimelineDisclosureKey,
  defaultExpanded = false,
): boolean {
  return state[key] ?? defaultExpanded;
}

export function toggleTimelineDisclosureExpansion(
  state: TimelineDisclosureExpansionState,
  key: TimelineDisclosureKey,
  defaultExpanded = false,
): TimelineDisclosureExpansionState {
  return {
    ...state,
    [key]: !(state[key] ?? defaultExpanded),
  };
}

function collectWorkEntryDisclosureKeys(
  keys: Set<TimelineDisclosureKey>,
  workEntry: TimelineWorkEntry,
) {
  keys.add(workDetailDisclosureKey(workEntry.id));
  keys.add(commandOutputDisclosureKey(workEntry.id));
}

function collectMetaGroupEntryDisclosureKeys(
  keys: Set<TimelineDisclosureKey>,
  entry: TimelineMetaGroupEntry,
) {
  if (entry.kind === "work") {
    collectWorkEntryDisclosureKeys(keys, entry.workEntry);
  }
}

function collectWorkLogRowDisclosureKeys(
  keys: Set<TimelineDisclosureKey>,
  row: TimelineWorkLogRow,
) {
  if (row.kind === "work") {
    collectWorkEntryDisclosureKeys(keys, row.workEntry);
    return;
  }
  if (row.kind !== "work-group") {
    return;
  }
  keys.add(workGroupDisclosureKey(row.id));
  for (const entry of row.entries) {
    collectMetaGroupEntryDisclosureKeys(keys, entry);
  }
}

function collectCompletedWorkDetailRowDisclosureKeys(
  keys: Set<TimelineDisclosureKey>,
  completedWorkSummaryId: string,
  row: TimelineCompletedWorkDetailRow,
) {
  if (row.kind === "assistant-update") {
    return;
  }
  if (row.kind === "work-group") {
    keys.add(completedWorkDetailGroupDisclosureKey(completedWorkSummaryId, row.id));
  }
  collectWorkLogRowDisclosureKeys(keys, row);
}

export function collectTimelineRowDisclosureKeys(
  row: TimelineRow,
): ReadonlySet<TimelineDisclosureKey> {
  const keys = new Set<TimelineDisclosureKey>();
  if (row.kind === "completed-work-summary") {
    keys.add(completedWorkSummaryDisclosureKey(row.id));
    for (const detailRow of row.detailRows) {
      collectCompletedWorkDetailRowDisclosureKeys(keys, row.id, detailRow);
    }
    for (const diagnosticRow of row.visibleDiagnosticRows) {
      collectWorkLogRowDisclosureKeys(keys, diagnosticRow);
    }
    return keys;
  }
  if (row.kind === "work" || row.kind === "work-group" || row.kind === "intent") {
    collectWorkLogRowDisclosureKeys(keys, row);
  }
  return keys;
}

export function collectTimelineRowsDisclosureKeys(
  rows: ReadonlyArray<TimelineRow>,
): ReadonlySet<TimelineDisclosureKey> {
  const keys = new Set<TimelineDisclosureKey>();
  for (const row of rows) {
    for (const key of collectTimelineRowDisclosureKeys(row)) {
      keys.add(key);
    }
  }
  return keys;
}

export function pruneTimelineDisclosureExpansionState(
  state: TimelineDisclosureExpansionState,
  validKeys: ReadonlySet<TimelineDisclosureKey>,
): TimelineDisclosureExpansionState {
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(state)) {
    if (validKeys.has(key as TimelineDisclosureKey)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : state;
}

export function timelineDisclosureRevisionKey(state: TimelineDisclosureExpansionState): string {
  const entries = Object.keys(state)
    .toSorted()
    .map((key) => `${key}:${state[key] ? 1 : 0}`);
  return entries.length === 0 ? "closed" : entries.join("\0");
}
