import { type OrchestrationThreadActivity, type TurnId } from "@ace/contracts";

import type { WorkLogEntry } from "./types";
import {
  asRecord,
  asTrimmedString,
  compareActivitiesByOrder,
  extractChangedFiles,
  extractEmbeddedIntentText,
  extractToolCommand,
  extractToolDetail,
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
const MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS = 16_000;

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
  if (activity.kind === "workspace.summary.generated") {
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
  const terminalOutput = extractTerminalOutput(payload);
  const rawChangedFiles = extractChangedFiles(payload);
  const rawChangedFileStats = extractChangedFileStats(payload);
  const title = extractToolTitle(payload);
  const embeddedIntentText = extractEmbeddedIntentText(payload);
  const status = extractToolStatus(payload);
  const exitCode = extractToolExitCode(payload);
  const durationMs = extractToolDurationMs(payload);
  const subagent = extractSubagentMetadata(payload);
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
    ...(activity.kind === "runtime.error"
      ? { diagnosticKind: "runtime-error" as const }
      : activity.kind === "runtime.warning"
        ? { diagnosticKind: "runtime-warning" as const }
        : {}),
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const changedFiles = requestKind === "file-change" ? rawChangedFiles : [];
  const changedFileStats =
    requestKind === "file-change"
      ? rawChangedFileStats.filter((stat) => changedFiles.includes(stat.path))
      : [];
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
      const stripped = stripTrailingExitCode(sanitizeWorkLogText(rawDetail));
      const cleaned = stripped.output;
      if (stripped.exitCode !== undefined && entry.exitCode === undefined) {
        entry.exitCode = stripped.exitCode;
      }
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
    const extractedDetail = extractToolDetail(payload);
    const stripped = extractedDetail
      ? stripTrailingExitCode(sanitizeWorkLogText(extractedDetail))
      : null;
    const detail = stripped?.output ?? null;
    if (stripped?.exitCode !== undefined && entry.exitCode === undefined) {
      entry.exitCode = stripped.exitCode;
    }
    if (detail) {
      entry.detail = detail;
    }
  } else if (payload) {
    const detail = extractToolDetail(payload);
    if (detail) {
      const normalizedDetail = stripTrailingExitCode(sanitizeWorkLogText(detail)).output;
      if (normalizedDetail) {
        entry.detail = normalizedDetail;
      }
    }
  }
  if (command) {
    entry.command = command;
  }
  if (terminalOutput) {
    entry.terminalOutput = terminalOutput;
  }
  if (payload?.terminalOutputTruncated === true) {
    entry.terminalOutputTruncated = true;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (changedFileStats.length > 0) {
    entry.changedFileStats = changedFileStats;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (status) {
    entry.status = status;
  }
  if (exitCode !== undefined) {
    entry.exitCode = exitCode;
  }
  if (durationMs !== undefined) {
    entry.durationMs = durationMs;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (subagent.id) {
    entry.subagentId = subagent.id;
  }
  if (subagent.type) {
    entry.subagentType = subagent.type;
  }
  if (subagent.name) {
    entry.subagentName = subagent.name;
  }
  if (subagent.model) {
    entry.subagentModel = subagent.model;
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
  const requestKind = next.requestKind ?? previous.requestKind;
  const changedFiles =
    requestKind === "file-change"
      ? mergeChangedFiles(previous.changedFiles, next.changedFiles)
      : [];
  const detail =
    previous.tone === "thinking" && next.tone === "thinking"
      ? mergeThinkingWorkLogDetail(previous.detail, next.detail)
      : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const terminalOutputResult = mergeTerminalOutput(
    previous.terminalOutput,
    next.terminalOutput,
    previous.terminalOutputTruncated === true || next.terminalOutputTruncated === true,
  );
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const label = shouldPreservePreviousToolLabel(previous, next) ? previous.label : next.label;
  const itemType = next.itemType ?? previous.itemType;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const changedFileStats = mergeChangedFileStats(previous.changedFileStats, next.changedFileStats);
  const status = next.status ?? previous.status;
  const exitCode = next.exitCode ?? previous.exitCode;
  const durationMs = next.durationMs ?? previous.durationMs;
  const subagentId = next.subagentId ?? previous.subagentId;
  const subagentType = next.subagentType ?? previous.subagentType;
  const subagentName = next.subagentName ?? previous.subagentName;
  const subagentModel = next.subagentModel ?? previous.subagentModel;
  return {
    ...previous,
    ...next,
    label,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined || next.sequence !== undefined
      ? { sequence: previous.sequence ?? next.sequence }
      : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(terminalOutputResult.terminalOutput
      ? { terminalOutput: terminalOutputResult.terminalOutput }
      : {}),
    ...(terminalOutputResult.terminalOutputTruncated ? { terminalOutputTruncated: true } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(changedFileStats.length > 0 ? { changedFileStats } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(status ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(subagentId ? { subagentId } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(subagentName ? { subagentName } : {}),
    ...(subagentModel ? { subagentModel } : {}),
    ...(collapseKey ? { collapseKey } : {}),
  };
}

function extractSubagentMetadata(payload: Record<string, unknown> | null): {
  id?: string | undefined;
  type?: string | undefined;
  name?: string | undefined;
  model?: string | undefined;
} {
  const data = asRecord(payload?.data);
  const ace = asRecord(data?.ace);
  const aceSubagent = asRecord(ace?.subagent);
  const subagent = asRecord(data?.subagent) ?? aceSubagent;
  const input = asRecord(data?.input);
  const args = asRecord(data?.arguments);
  const item = asRecord(data?.item);
  const result = asRecord(data?.result);
  const receiverThreadId = firstTrimmedString(item?.receiverThreadIds);
  const childProviderThreadId =
    asTrimmedString(ace?.childProviderThreadId) ??
    asTrimmedString(data?.childProviderThreadId) ??
    asTrimmedString(data?.child_provider_thread_id) ??
    asTrimmedString(item?.childProviderThreadId) ??
    asTrimmedString(item?.child_provider_thread_id) ??
    receiverThreadId;
  return {
    id:
      asTrimmedString(subagent?.id) ??
      childProviderThreadId ??
      asTrimmedString(data?.agentId) ??
      asTrimmedString(data?.agent_id) ??
      asTrimmedString(result?.agentId) ??
      asTrimmedString(result?.agent_id) ??
      undefined,
    type:
      asTrimmedString(subagent?.type) ??
      asTrimmedString(data?.subagentType) ??
      asTrimmedString(data?.subagent_type) ??
      asTrimmedString(input?.subagentType) ??
      asTrimmedString(input?.subagent_type) ??
      asTrimmedString(args?.subagentType) ??
      asTrimmedString(args?.subagent_type) ??
      (childProviderThreadId ? "codex subagent" : undefined) ??
      undefined,
    name:
      asTrimmedString(subagent?.name) ??
      asTrimmedString(subagent?.displayName) ??
      asTrimmedString(subagent?.display_name) ??
      asTrimmedString(data?.agentName) ??
      asTrimmedString(data?.agent_name) ??
      asTrimmedString(data?.name) ??
      asTrimmedString(item?.agentName) ??
      asTrimmedString(item?.agent_name) ??
      asTrimmedString(item?.name) ??
      asTrimmedString(input?.agentName) ??
      asTrimmedString(input?.agent_name) ??
      asTrimmedString(input?.name) ??
      asTrimmedString(args?.agentName) ??
      asTrimmedString(args?.agent_name) ??
      asTrimmedString(args?.name) ??
      undefined,
    model:
      asTrimmedString(subagent?.model) ??
      asTrimmedString(data?.model) ??
      asTrimmedString(input?.model) ??
      asTrimmedString(args?.model) ??
      undefined,
  };
}

function firstTrimmedString(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return asTrimmedString(value);
  }
  for (const item of value) {
    const normalized = asTrimmedString(item);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function shouldPreservePreviousToolLabel(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isToolLifecycleActivityKind(previous.activityKind)) {
    return false;
  }
  const normalizedNextLabel = next.label.toLowerCase();
  return (
    normalizedNextLabel === "command output" ||
    normalizedNextLabel === "file output" ||
    normalizedNextLabel === "tool"
  );
}

function extractToolStatus(
  payload: Record<string, unknown> | null,
): WorkLogEntry["status"] | undefined {
  const status = asTrimmedString(payload?.status);
  if (status === "inProgress" || status === "completed" || status === "failed") {
    return status;
  }
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemStatus = asTrimmedString(item?.status);
  if (itemStatus === "inProgress" || itemStatus === "completed" || itemStatus === "failed") {
    return itemStatus;
  }
  if (itemStatus === "error") {
    return "failed";
  }
  return undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function extractToolExitCode(payload: Record<string, unknown> | null): number | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const output = asRecord(item?.output) ?? asRecord(data?.output) ?? asRecord(result?.output);
  return (
    asFiniteInteger(payload?.exitCode) ??
    asFiniteInteger(data?.exitCode) ??
    asFiniteInteger(data?.exit_code) ??
    asFiniteInteger(item?.exitCode) ??
    asFiniteInteger(item?.exit_code) ??
    asFiniteInteger(result?.exitCode) ??
    asFiniteInteger(result?.exit_code) ??
    asFiniteInteger(output?.exitCode) ??
    asFiniteInteger(output?.exit_code)
  );
}

function extractToolDurationMs(payload: Record<string, unknown> | null): number | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const duration =
    asFiniteInteger(payload?.durationMs) ??
    asFiniteInteger(payload?.duration_ms) ??
    asFiniteInteger(data?.durationMs) ??
    asFiniteInteger(data?.duration_ms) ??
    asFiniteInteger(item?.durationMs) ??
    asFiniteInteger(item?.duration_ms) ??
    asFiniteInteger(result?.durationMs) ??
    asFiniteInteger(result?.duration_ms);
  return duration !== undefined && duration >= 0 ? duration : undefined;
}

function extractTerminalOutput(payload: Record<string, unknown> | null): string | null {
  const direct = terminalOutputString(payload?.terminalOutput);
  if (direct !== null) {
    return direct;
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const output = asRecord(item?.output) ?? asRecord(data?.output) ?? asRecord(result?.output);
  for (const candidate of [
    item?.aggregatedOutput,
    item?.aggregated_output,
    result?.aggregatedOutput,
    result?.aggregated_output,
    output?.aggregatedOutput,
    output?.aggregated_output,
    data?.aggregatedOutput,
    data?.aggregated_output,
    output?.text,
    result?.text,
  ]) {
    const normalized = terminalOutputString(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

function terminalOutputString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.trim().length > 0 ? normalized : null;
}

function mergeTerminalOutput(
  previous: string | undefined,
  next: string | undefined,
  alreadyTruncated: boolean,
): { terminalOutput: string | undefined; terminalOutputTruncated: boolean } {
  if (!previous) {
    return truncateWorkLogTerminalOutput(next, alreadyTruncated);
  }
  if (!next) {
    return { terminalOutput: previous, terminalOutputTruncated: alreadyTruncated };
  }
  if (alreadyTruncated && previous.length >= MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS) {
    return { terminalOutput: previous, terminalOutputTruncated: true };
  }
  let merged: string;
  if (next.startsWith(previous)) {
    merged = next;
  } else if (previous.endsWith(next)) {
    merged = previous;
  } else {
    merged = `${previous}${next}`;
  }
  return truncateWorkLogTerminalOutput(merged, alreadyTruncated);
}

function truncateWorkLogTerminalOutput(
  output: string | undefined,
  alreadyTruncated: boolean,
): { terminalOutput: string | undefined; terminalOutputTruncated: boolean } {
  if (!output) {
    return { terminalOutput: undefined, terminalOutputTruncated: alreadyTruncated };
  }
  if (output.length <= MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS) {
    return { terminalOutput: output, terminalOutputTruncated: alreadyTruncated };
  }
  return {
    terminalOutput: `${output.slice(0, MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS - 3)}...`,
    terminalOutputTruncated: true,
  };
}

function extractChangedFileStats(
  payload: Record<string, unknown> | null,
): Array<{ path: string; additions?: number; deletions?: number }> {
  const stats: Array<{ path: string; additions?: number; deletions?: number }> = [];
  const byPath = new Map<string, { path: string; additions?: number; deletions?: number }>();
  collectChangedFileStats(asRecord(payload?.data), byPath, 0);
  for (const stat of byPath.values()) {
    stats.push(stat);
  }
  return stats;
}

function collectChangedFileStats(
  value: unknown,
  byPath: Map<string, { path: string; additions?: number; deletions?: number }>,
  depth: number,
) {
  if (depth > 5 || byPath.size >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFileStats(entry, byPath, depth + 1);
      if (byPath.size >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const path =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.file_path) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.absolutePath) ??
    asTrimmedString(record.filename);
  if (path) {
    const additions =
      asFiniteInteger(record.additions) ??
      asFiniteInteger(record.added) ??
      asFiniteInteger(record.linesAdded);
    const deletions =
      asFiniteInteger(record.deletions) ??
      asFiniteInteger(record.deleted) ??
      asFiniteInteger(record.linesDeleted);
    if (additions !== undefined || deletions !== undefined) {
      const existing = byPath.get(path);
      byPath.set(path, {
        path,
        additions: Math.max(existing?.additions ?? 0, additions ?? 0),
        deletions: Math.max(existing?.deletions ?? 0, deletions ?? 0),
      });
    }
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "arguments",
    "data",
    "rawOutput",
    "changes",
    "files",
    "locations",
    "edits",
  ] as const) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFileStats(record[nestedKey], byPath, depth + 1);
    if (byPath.size >= 12) {
      return;
    }
  }
}

function mergeChangedFileStats(
  previous: WorkLogEntry["changedFileStats"],
  next: WorkLogEntry["changedFileStats"],
): Array<{ path: string; additions?: number; deletions?: number }> {
  const byPath = new Map<string, { path: string; additions?: number; deletions?: number }>();
  for (const stat of [...(previous ?? []), ...(next ?? [])]) {
    const existing = byPath.get(stat.path);
    byPath.set(stat.path, {
      path: stat.path,
      additions: Math.max(existing?.additions ?? 0, stat.additions ?? 0),
      deletions: Math.max(existing?.deletions ?? 0, stat.deletions ?? 0),
    });
  }
  return [...byPath.values()];
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
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (latestTurnId && activity.turnId !== latestTurnId) {
      continue;
    }
    if (!isRenderableWorkLogActivity(activity)) {
      continue;
    }
    entries.push(toDerivedWorkLogEntry(activity));
  }
  const collapsedEntries = collapseDerivedWorkLogEntries(entries);
  const normalizedEntries: WorkLogEntry[] = [];
  for (const {
    activityKind: _activityKind,
    collapseKey: _collapseKey,
    ...entry
  } of collapsedEntries) {
    normalizedEntries.push(entry);
  }
  return normalizedEntries;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}
