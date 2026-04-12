import { type OrchestrationThreadActivity, type TurnId } from "@ace/contracts";

import type { WorkLogEntry } from "./types";
import {
  asRecord,
  asTrimmedString,
  compareActivitiesByOrder,
  extractChangedFiles,
  extractEmbeddedIntentText,
  extractToolCommand,
  extractToolTitle,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
  sanitizeWorkLogText,
  stripTrailingExitCode,
} from "./shared";

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

export interface ActivityVisibilitySettings {
  readonly enableToolStreaming: boolean;
  readonly enableThinkingStreaming: boolean;
}

const THINKING_ACTIVITY_KINDS = new Set<OrchestrationThreadActivity["kind"]>([
  "turn.plan.updated",
  "task.started",
  "task.progress",
  "task.completed",
  "reasoning.completed",
]);

const TOOL_ACTIVITY_KINDS = new Set<OrchestrationThreadActivity["kind"]>([
  "tool.started",
  "tool.updated",
  "tool.completed",
]);

function shouldHideWorkLogActivityForVisibility(
  activity: OrchestrationThreadActivity,
  visibility: ActivityVisibilitySettings,
): boolean {
  if (!visibility.enableThinkingStreaming && THINKING_ACTIVITY_KINDS.has(activity.kind)) {
    return true;
  }

  if (!visibility.enableToolStreaming && TOOL_ACTIVITY_KINDS.has(activity.kind)) {
    return true;
  }

  return false;
}

export function filterVisibleWorkLogActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  visibility: ActivityVisibilitySettings,
): ReadonlyArray<OrchestrationThreadActivity> {
  if (visibility.enableToolStreaming && visibility.enableThinkingStreaming) {
    return activities;
  }

  return activities.filter(
    (activity) => !shouldHideWorkLogActivityForVisibility(activity, visibility),
  );
}

function ensureActivitiesOrdered(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  for (let index = 1; index < activities.length; index += 1) {
    const previous = activities[index - 1];
    const current = activities[index];
    if (!previous || !current) {
      continue;
    }
    if (compareActivitiesByOrder(previous, current) > 0) {
      return [...activities].toSorted(compareActivitiesByOrder);
    }
  }
  return activities;
}

export function findLatestRenderableWorkTurnId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnId | undefined {
  const ordered = ensureActivitiesOrdered(activities);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const activity = ordered[index];
    if (!activity) {
      continue;
    }
    if (activity.turnId && isRenderableWorkLogActivity(activity)) {
      return activity.turnId;
    }
  }
  return undefined;
}

function isRenderableWorkLogActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return false;
  }
  if (activity.kind === "context-window.updated") {
    return false;
  }
  if (activity.summary === "Checkpoint captured") {
    return false;
  }
  return !isPlanBoundaryToolActivity(activity);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

const RUNTIME_DETAIL_JSON_MAX = 4000;

function stringifyRuntimeDetailUnknown(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    if (text.length <= RUNTIME_DETAIL_JSON_MAX) {
      return text;
    }
    return `${text.slice(0, RUNTIME_DETAIL_JSON_MAX - 1)}…`;
  } catch {
    const fallback = String(value).trim();
    return fallback.length > 0 ? fallback : null;
  }
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const command = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const embeddedIntentText = extractEmbeddedIntentText(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    label: sanitizeWorkLogText(activity.summary),
    tone:
      activity.kind === "task.progress" ||
      activity.kind === "reasoning.completed" ||
      payload?.itemType === "reasoning"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const isRuntimeDiagnostic =
    activity.kind === "runtime.error" || activity.kind === "runtime.warning";
  if (isRuntimeDiagnostic && payload) {
    const parts: string[] = [];
    const rawMessage = asTrimmedString(payload.message);
    if (rawMessage) {
      const cleaned = stripTrailingExitCode(sanitizeWorkLogText(rawMessage)).output;
      if (cleaned) {
        parts.push(cleaned);
      }
    }
    const rawDetail = payload.detail;
    if (typeof rawDetail === "string" && rawDetail.trim()) {
      const cleaned = stripTrailingExitCode(sanitizeWorkLogText(rawDetail)).output;
      if (cleaned && cleaned !== rawMessage) {
        parts.push(cleaned);
      }
    } else if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== "string") {
      const serialized = stringifyRuntimeDetailUnknown(rawDetail);
      if (serialized) {
        parts.push(serialized);
      }
    }
    const combined = parts.join("\n\n");
    if (combined) {
      entry.detail = combined;
    }
  } else if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const detail = stripTrailingExitCode(sanitizeWorkLogText(payload.detail)).output;
    if (detail) {
      entry.detail = detail;
    }
  }
  if (command) {
    entry.command = command;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (embeddedIntentText && entry.tone === "tool") {
    entry.intentText = embeddedIntentText;
  }
  const collapseKey = deriveActivityCollapseKey(entry, payload, activity.turnId);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const activeStableToolLifecycleIndexByKey = new Map<string, number>();

  for (const entry of entries) {
    const stableToolLifecycleKey =
      entry.collapseKey && isStableToolLifecycleCollapseKey(entry.collapseKey)
        ? entry.collapseKey
        : undefined;
    if (stableToolLifecycleKey) {
      const existingIndex = activeStableToolLifecycleIndexByKey.get(stableToolLifecycleKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex];
        if (existing && shouldCollapseToolLifecycleEntries(existing, entry)) {
          const merged = mergeDerivedWorkLogEntries(existing, entry);
          collapsed[existingIndex] = merged;
          if (merged.activityKind === "tool.completed") {
            activeStableToolLifecycleIndexByKey.delete(stableToolLifecycleKey);
          }
          continue;
        }
      }
    }

    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[collapsed.length - 1] = merged;
      const mergedStableToolLifecycleKey =
        merged.collapseKey && isStableToolLifecycleCollapseKey(merged.collapseKey)
          ? merged.collapseKey
          : undefined;
      if (mergedStableToolLifecycleKey) {
        if (merged.activityKind === "tool.completed") {
          activeStableToolLifecycleIndexByKey.delete(mergedStableToolLifecycleKey);
        } else {
          activeStableToolLifecycleIndexByKey.set(
            mergedStableToolLifecycleKey,
            collapsed.length - 1,
          );
        }
      }
      continue;
    }

    collapsed.push(entry);
    if (stableToolLifecycleKey && entry.activityKind !== "tool.completed") {
      activeStableToolLifecycleIndexByKey.set(stableToolLifecycleKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.collapseKey === undefined || previous.collapseKey !== next.collapseKey) {
    return false;
  }

  if (previous.tone === "thinking" && next.tone === "thinking") {
    return true;
  }

  if (
    !isToolLifecycleActivityKind(previous.activityKind) ||
    !isToolLifecycleActivityKind(next.activityKind)
  ) {
    return false;
  }

  return previous.activityKind !== "tool.completed";
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail =
    previous.tone === "thinking" && next.tone === "thinking"
      ? mergeThinkingWorkLogDetail(previous.detail, next.detail)
      : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  return {
    ...previous,
    ...next,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined || next.sequence !== undefined
      ? { sequence: previous.sequence ?? next.sequence }
      : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
  };
}

function mergeThinkingWorkLogDetail(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }

  const needsSpace = /[A-Za-z0-9).!?]$/.test(previous) && /^[A-Za-z0-9(]/.test(next);
  return `${previous}${needsSpace ? " " : ""}${next}`;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function isToolLifecycleActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

function isStableToolLifecycleCollapseKey(key: string): boolean {
  return key.startsWith("tool-id:");
}

function extractToolLifecycleIdentifier(payload: Record<string, unknown> | null): string | null {
  const directCandidates = [
    asTrimmedString(payload?.itemId),
    asTrimmedString(payload?.toolCallId),
    asTrimmedString(payload?.tool_call_id),
  ];
  for (const candidate of directCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const nestedCandidates = [
    asTrimmedString(data?.toolCallId),
    asTrimmedString(data?.tool_call_id),
    asTrimmedString(item?.toolCallId),
    asTrimmedString(item?.tool_call_id),
    asTrimmedString(item?.id),
  ];
  for (const candidate of nestedCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function deriveActivityCollapseKey(
  entry: DerivedWorkLogEntry,
  payload: Record<string, unknown> | null,
  turnId: TurnId | null | undefined,
): string | undefined {
  const turnSegment = turnId ?? "none";
  if (entry.tone === "thinking") {
    const taskId = asTrimmedString(payload?.taskId);
    if (taskId) {
      return `thinking:${turnSegment}:${taskId}`;
    }
  }

  if (!isToolLifecycleActivityKind(entry.activityKind)) {
    return undefined;
  }

  const toolLifecycleIdentifier = extractToolLifecycleIdentifier(payload);
  if (toolLifecycleIdentifier) {
    return `tool-id:${turnSegment}:${toolLifecycleIdentifier}`;
  }

  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return `tool-fallback:${[turnSegment, itemType, normalizedLabel].join("\u001f")}`;
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:start(?:ed)?|complete|completed)\s*$/i, "").trim();
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId?: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = ensureActivitiesOrdered(activities);
  const entries = ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter(isRenderableWorkLogActivity)
    .map(toDerivedWorkLogEntry);
  return collapseDerivedWorkLogEntries(entries).map(
    ({ activityKind: _activityKind, collapseKey: _collapseKey, ...entry }) => entry,
  );
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}
