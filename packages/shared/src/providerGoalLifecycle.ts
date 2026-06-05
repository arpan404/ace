export type ProviderGoalLifecycleStatus = "active" | "paused" | "completed" | "blocked";

export type ProviderGoalLifecycleSnapshot =
  | {
      readonly action: "updated";
      readonly status: ProviderGoalLifecycleStatus;
      readonly objective: string;
      readonly threadId?: string;
      readonly tokenBudget?: number;
      readonly tokensUsed?: number;
      readonly timeUsedSeconds?: number;
    }
  | {
      readonly action: "cleared";
      readonly threadId?: string;
    };

const GOAL_LIFECYCLE_LABELS = new Set([
  "goal updated",
  "goal update",
  "goal set",
  "goal created",
  "goal paused",
  "goal resumed",
  "goal cleared",
  "goal deleted",
  "goal completed",
  "goal blocked",
  "get goal",
  "create goal",
  "update goal",
  "clear goal",
  "delete goal",
]);

const GOAL_LIFECYCLE_TOOL_NAMES = new Set([
  "create_goal",
  "get_goal",
  "goal_clear",
  "goal_cleared",
  "goal_set",
  "goal_update",
  "goal_updated",
  "update_goal",
  "set_goal",
  "pause_goal",
  "resume_goal",
  "complete_goal",
  "block_goal",
  "clear_goal",
  "delete_goal",
  "thread_goal_clear",
  "thread_goal_cleared",
  "thread_goal_set",
  "thread_goal_update",
  "thread_goal_updated",
]);

const NESTED_KEYS = [
  "data",
  "item",
  "items",
  "input",
  "inputs",
  "rawInput",
  "raw_input",
  "arguments",
  "args",
  "result",
  "results",
  "output",
  "outputs",
  "content",
  "contents",
  "description",
  "delta",
  "message",
  "messages",
  "text",
  "outputText",
  "output_text",
  "tool",
  "toolCall",
  "tool_call",
  "toolCalls",
  "tool_calls",
  "function",
  "functionCall",
  "function_call",
  "call",
  "calls",
  "params",
  "parameters",
  "request",
  "response",
  "payload",
  "event",
  "metadata",
  "meta",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asLifecycleStatus(value: unknown): ProviderGoalLifecycleStatus | null {
  return value === "active" || value === "paused" || value === "completed" || value === "blocked"
    ? value
    : null;
}

export function normalizeProviderGoalLifecycleText(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) {
    return null;
  }
  return raw
    .replace(/^[\s✓✔✅✕✖✗●•\-–—:;,.()[\]{}]+/u, "")
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function hasProviderGoalLifecycleToolName(value: unknown): boolean {
  const raw = asTrimmedString(value);
  if (!raw) {
    return false;
  }
  const normalized = raw
    .replace(/^functions?\./iu, "")
    .replace(/^tools?\./iu, "")
    .replace(/^mcp\./iu, "")
    .trim()
    .toLowerCase();
  const canonical = normalized.replace(/[-\s.:/]+/gu, "_");
  if (GOAL_LIFECYCLE_TOOL_NAMES.has(canonical)) {
    return true;
  }

  const namespaceParts = normalized
    .split(/__|[-\s.:/]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (let partCount = 1; partCount <= Math.min(namespaceParts.length, 3); partCount += 1) {
    const candidate = namespaceParts.slice(-partCount).join("_");
    if (GOAL_LIFECYCLE_TOOL_NAMES.has(candidate)) {
      return true;
    }
  }
  return false;
}

export function hasProviderGoalLifecycleLabel(value: unknown): boolean {
  const normalized = normalizeProviderGoalLifecycleText(value);
  if (!normalized) {
    return false;
  }
  if (GOAL_LIFECYCLE_LABELS.has(normalized)) {
    return true;
  }
  return /^(?:goal|thread goal)\s+(?:updated?|set|created|paused|resumed|cleared|deleted|completed|blocked)\b/u.test(
    normalized,
  );
}

function statusFromText(value: unknown): ProviderGoalLifecycleStatus | null {
  const normalized = normalizeProviderGoalLifecycleText(value);
  if (!normalized) {
    return null;
  }
  if (/^(?:goal|thread goal)\s+(?:paused|pause)\b/u.test(normalized)) {
    return "paused";
  }
  if (
    /^(?:goal|thread goal)\s+(?:completed|complete|finished|done|achieved|blocked)\b/u.test(
      normalized,
    )
  ) {
    return normalized.includes("blocked") ? "blocked" : "completed";
  }
  if (
    /^(?:goal|thread goal)\s+(?:updated?|set|created|resumed|resume)\b/u.test(normalized) ||
    /^(?:create|update|set|get)\s+goal\b/u.test(normalized)
  ) {
    return "active";
  }
  return null;
}

function isClearText(value: unknown): boolean {
  const normalized = normalizeProviderGoalLifecycleText(value);
  return normalized
    ? /^(?:goal|thread goal)\s+(?:cleared|clear|deleted|delete)\b/u.test(normalized) ||
        /^(?:clear|delete)\s+goal\b/u.test(normalized)
    : false;
}

function objectiveFromText(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) {
    return null;
  }
  const firstLine = raw.split(/\r?\n/u)[0];
  if (!hasProviderGoalLifecycleLabel(firstLine)) {
    return null;
  }
  const stripped = raw
    .replace(/^[\s✓✔✅✕✖✗●•\-–—:;,.()[\]{}]+/u, "")
    .replace(
      /^(?:goal|thread goal)\s+(?:updated?|set|created|paused|resumed|cleared|deleted|completed|blocked)\b[:\s-]*/iu,
      "",
    )
    .replace(/^(?:get|create|update|set|clear|delete)\s+goal\b[:\s-]*/iu, "")
    .trim();
  return stripped.length > 0 && !hasProviderGoalLifecycleLabel(stripped) ? stripped : null;
}

function hasSerializedSignal(value: unknown): boolean {
  const raw = asTrimmedString(value);
  if (!raw || raw.length > 8_000 || !/[{[]/u.test(raw)) {
    return false;
  }
  const lifecycleValue =
    /["'](?:name|toolName|tool_name|title|summary|detail|label|text|description|message|content|delta|output|outputText|output_text)["']\s*:\s*["'](?<value>[^"']+)["']/giu;
  for (const match of raw.matchAll(lifecycleValue)) {
    if (hasProviderGoalLifecycleLabel(match.groups?.value)) {
      return true;
    }
  }
  return false;
}

function hasGoalStateShape(record: Record<string, unknown>): boolean {
  const goal = asRecord(record.goal);
  const status = asLifecycleStatus(record.status) ?? asLifecycleStatus(record.state);
  const goalStatus = asLifecycleStatus(goal?.status);
  const objective =
    asTrimmedString(record.objective) ??
    asTrimmedString(record.goalObjective) ??
    asTrimmedString(record.goal_objective) ??
    asTrimmedString(goal?.objective);
  return Boolean((status || goalStatus) && objective);
}

export function hasProviderGoalLifecycleSignal(value: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasProviderGoalLifecycleSignal(item, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return (
      hasProviderGoalLifecycleLabel(value) ||
      hasProviderGoalLifecycleToolName(value) ||
      hasSerializedSignal(value)
    );
  }
  if (
    hasGoalStateShape(record) ||
    hasProviderGoalLifecycleLabel(record.summary) ||
    hasProviderGoalLifecycleLabel(record.title) ||
    hasProviderGoalLifecycleLabel(record.detail) ||
    hasProviderGoalLifecycleLabel(record.label) ||
    hasProviderGoalLifecycleLabel(record.name) ||
    hasProviderGoalLifecycleLabel(record.text) ||
    hasProviderGoalLifecycleLabel(record.description) ||
    hasProviderGoalLifecycleLabel(record.message) ||
    hasProviderGoalLifecycleLabel(record.content) ||
    hasProviderGoalLifecycleLabel(record.delta) ||
    hasProviderGoalLifecycleLabel(record.output) ||
    hasProviderGoalLifecycleLabel(record.outputText) ||
    hasProviderGoalLifecycleLabel(record.output_text) ||
    hasProviderGoalLifecycleLabel(record.toolName) ||
    hasProviderGoalLifecycleLabel(record.tool_name) ||
    hasProviderGoalLifecycleToolName(record.name) ||
    hasProviderGoalLifecycleToolName(record.toolName) ||
    hasProviderGoalLifecycleToolName(record.tool_name) ||
    hasProviderGoalLifecycleToolName(record.functionName) ||
    hasProviderGoalLifecycleToolName(record.function_name)
  ) {
    return true;
  }
  for (const key of NESTED_KEYS) {
    if (key in record && hasProviderGoalLifecycleSignal(record[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

function findStatus(value: unknown, depth = 0): ProviderGoalLifecycleStatus | null {
  if (depth > 6) {
    return null;
  }
  const lifecycleStatus = asLifecycleStatus(value);
  if (lifecycleStatus) {
    return lifecycleStatus;
  }
  const direct = statusFromText(value);
  if (direct) {
    return direct;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findStatus(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const itemType = asTrimmedString(record.itemType ?? record.item_type ?? record.type);
  const normalizedItemType = itemType?.replace(/[_-]+/gu, " ") ?? null;
  const statusIsLifecycleStatus =
    normalizedItemType !== null &&
    /\b(?:tool|function|call|message|reasoning|item)\b/iu.test(normalizedItemType) &&
    (record.status === "completed" ||
      record.status === "in_progress" ||
      record.status === "running");
  for (const candidate of [
    statusIsLifecycleStatus ? undefined : record.status,
    statusIsLifecycleStatus ? undefined : record.state,
    asRecord(record.goal)?.status,
  ]) {
    const status = findStatus(candidate, depth + 1);
    if (status) return status;
  }
  for (const key of NESTED_KEYS) {
    if (key in record) {
      const nested = findStatus(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function findNonNegativeNumber(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): number | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findNonNegativeNumber(item, keys, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const direct = asNonNegativeNumber(record[key]);
    if (direct !== undefined) {
      return direct;
    }
  }
  for (const key of NESTED_KEYS) {
    if (key in record) {
      const nested = findNonNegativeNumber(record[key], keys, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function findObjective(value: unknown, depth = 0): string | null {
  if (depth > 6) {
    return null;
  }
  const direct = objectiveFromText(value);
  if (direct) {
    return direct;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findObjective(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  for (const candidate of [
    record.objective,
    record.goal,
    asRecord(record.goal)?.objective,
    record.detail,
    record.text,
    record.outputText,
    record.output_text,
    record.description,
    record.message,
    record.content,
    record.output,
    record.result,
  ]) {
    const normalized = asTrimmedString(candidate);
    if (normalized && !hasProviderGoalLifecycleLabel(normalized) && candidate !== record.goal) {
      return normalized;
    }
    const nested = findObjective(candidate, depth + 1);
    if (nested) return nested;
  }
  for (const key of NESTED_KEYS) {
    if (key in record) {
      const nested = findObjective(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function findThreadId(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findThreadId(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct =
    asTrimmedString(record.threadId) ??
    asTrimmedString(record.thread_id) ??
    asTrimmedString(record.providerThreadId) ??
    asTrimmedString(record.provider_thread_id) ??
    asTrimmedString(asRecord(record.goal)?.threadId) ??
    asTrimmedString(asRecord(record.goal)?.thread_id);
  if (direct) {
    return direct;
  }
  for (const key of NESTED_KEYS) {
    if (key in record) {
      const nested = findThreadId(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function hasClearSignal(value: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }
  if (isClearText(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasClearSignal(item, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  for (const candidate of [
    record.summary,
    record.title,
    record.detail,
    record.label,
    record.text,
    record.description,
    record.message,
    record.content,
    record.output,
    record.outputText,
    record.output_text,
    record.name,
    record.toolName,
    record.tool_name,
  ]) {
    if (isClearText(candidate)) {
      return true;
    }
  }
  for (const key of NESTED_KEYS) {
    if (key in record && hasClearSignal(record[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

export function parseProviderGoalLifecycle(value: unknown): ProviderGoalLifecycleSnapshot | null {
  if (!hasProviderGoalLifecycleSignal(value)) {
    return null;
  }
  const threadId = findThreadId(value);
  if (hasClearSignal(value)) {
    return {
      action: "cleared",
      ...(threadId ? { threadId } : {}),
    };
  }
  const objective = findObjective(value);
  if (!objective) {
    return null;
  }
  const status = findStatus(value) ?? "active";
  const record = asRecord(value);
  const data = asRecord(record?.data);
  const goal = asRecord(record?.goal) ?? asRecord(data?.goal);
  const tokenBudget =
    asNonNegativeNumber(record?.tokenBudget) ??
    asNonNegativeNumber(goal?.tokenBudget) ??
    findNonNegativeNumber(value, new Set(["tokenBudget", "token_budget"]));
  const tokensUsed =
    asNonNegativeNumber(record?.tokensUsed) ??
    asNonNegativeNumber(goal?.tokensUsed) ??
    findNonNegativeNumber(value, new Set(["tokensUsed", "tokens_used"]));
  const timeUsedSeconds =
    asNonNegativeNumber(record?.timeUsedSeconds) ??
    asNonNegativeNumber(goal?.timeUsedSeconds) ??
    findNonNegativeNumber(value, new Set(["timeUsedSeconds", "time_used_seconds"]));
  return {
    action: "updated",
    status,
    objective,
    ...(threadId ? { threadId } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
  };
}
