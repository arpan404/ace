import type { CanonicalItemType, ProviderRuntimeEvent } from "@ace/contracts";
import { isToolLifecycleItemType } from "@ace/contracts";

type ItemLifecycleEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

type NormalizedToolAction =
  | "command"
  | "file-read"
  | "file-change"
  | "search"
  | "web-search"
  | "image-view"
  | "mcp"
  | "collab-agent"
  | "tool";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text && text.length > 0 ? text : undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : undefined;
}

function firstTrimmedString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const candidate = asTrimmedString(value);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => asTrimmedString(part))
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return asTrimmedString(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(record?.[key]);
}

function parseTaggedText(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  const parsed: Record<string, string> = {};
  const tagPattern = /<([A-Za-z][\w-]*)>([\s\S]*?)<\/\1>/g;
  for (const match of value.matchAll(tagPattern)) {
    const key = match[1]?.trim();
    const content = match[2]?.trim();
    if (key && content && parsed[key] === undefined) {
      parsed[key] = content;
    }
  }
  return parsed;
}

function collectStringValues(value: unknown, keys: ReadonlySet<string>, depth = 0): string[] {
  if (depth > 5) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, keys, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const values: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key)) {
      const text = asTrimmedString(entry);
      if (text) {
        values.push(text);
      }
    }
    values.push(...collectStringValues(entry, keys, depth + 1));
  }
  return values;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function lifecycleRecords(payload: ItemLifecycleEvent["payload"]): {
  data: Record<string, unknown> | undefined;
  item: Record<string, unknown> | undefined;
  input: Record<string, unknown> | undefined;
  args: Record<string, unknown> | undefined;
  result: Record<string, unknown> | undefined;
  output: Record<string, unknown> | undefined;
} {
  const data = asRecord(payload.data);
  const item = readNestedRecord(data, "item") ?? data;
  const input =
    readNestedRecord(item, "input") ??
    readNestedRecord(data, "input") ??
    readNestedRecord(data, "arguments") ??
    readNestedRecord(data, "args") ??
    readNestedRecord(data, "rawInput");
  const args = readNestedRecord(data, "arguments") ?? readNestedRecord(data, "args") ?? input;
  const result = readNestedRecord(item, "result") ?? readNestedRecord(data, "result");
  const output = readNestedRecord(item, "output") ?? readNestedRecord(data, "output") ?? result;
  return { data, item, input, args, result, output };
}

function toolNameFromLifecycle(payload: ItemLifecycleEvent["payload"]): string | undefined {
  const { data, item, input, args } = lifecycleRecords(payload);
  return firstTrimmedString(
    payload.title,
    data?.toolName,
    data?.tool_name,
    data?.name,
    data?.toolTitle,
    data?.tool_title,
    item?.toolName,
    item?.tool_name,
    item?.name,
    input?.toolName,
    input?.tool_name,
    input?.name,
    args?.toolName,
    args?.tool_name,
    args?.name,
  );
}

function commandFromLifecycle(payload: ItemLifecycleEvent["payload"]): string | undefined {
  const { data, item, input, args, result } = lifecycleRecords(payload);
  const taggedDetail = parseTaggedText(payload.detail);
  return (
    normalizeCommandValue(item?.command) ??
    normalizeCommandValue(item?.cmd) ??
    normalizeCommandValue(input?.command) ??
    normalizeCommandValue(input?.cmd) ??
    normalizeCommandValue(args?.command) ??
    normalizeCommandValue(args?.cmd) ??
    normalizeCommandValue(result?.command) ??
    normalizeCommandValue(result?.cmd) ??
    normalizeCommandValue(data?.command) ??
    normalizeCommandValue(data?.cmd) ??
    normalizeCommandValue(data?.fullCommandText) ??
    normalizeCommandValue(data?.full_command_text) ??
    normalizeCommandValue(taggedDetail.command) ??
    normalizeCommandValue(taggedDetail.cmd)
  );
}

function cwdFromLifecycle(payload: ItemLifecycleEvent["payload"]): string | undefined {
  const { data, item, input, args, result } = lifecycleRecords(payload);
  return firstTrimmedString(
    item?.cwd,
    input?.cwd,
    args?.cwd,
    result?.cwd,
    data?.cwd,
    data?.workingDirectory,
    data?.working_directory,
  );
}

function outputFromLifecycle(payload: ItemLifecycleEvent["payload"]): string | undefined {
  const { data, item, result, output } = lifecycleRecords(payload);
  const stdoutStderr = (...records: ReadonlyArray<Record<string, unknown> | undefined>) => {
    for (const record of records) {
      const stdout = asTrimmedString(record?.stdout);
      const stderr = asTrimmedString(record?.stderr);
      const joined = [stdout, stderr].filter((entry): entry is string => Boolean(entry)).join("\n");
      if (joined) {
        return joined;
      }
    }
    return undefined;
  };
  return firstTrimmedString(
    item?.aggregatedOutput,
    item?.aggregated_output,
    result?.aggregatedOutput,
    result?.aggregated_output,
    output?.aggregatedOutput,
    output?.aggregated_output,
    data?.aggregatedOutput,
    data?.aggregated_output,
    stdoutStderr(item, result, output, data),
    output?.text,
    result?.text,
    data?.output,
  );
}

function exitCodeFromLifecycle(payload: ItemLifecycleEvent["payload"]): number | undefined {
  const { data, item, result, output } = lifecycleRecords(payload);
  return asFiniteInteger(
    item?.exitCode ??
      item?.exit_code ??
      result?.exitCode ??
      result?.exit_code ??
      output?.exitCode ??
      output?.exit_code ??
      data?.exitCode ??
      data?.exit_code,
  );
}

function durationMsFromLifecycle(payload: ItemLifecycleEvent["payload"]): number | undefined {
  const { data, item, result } = lifecycleRecords(payload);
  const duration = asFiniteInteger(
    item?.durationMs ??
      item?.duration_ms ??
      result?.durationMs ??
      result?.duration_ms ??
      data?.durationMs ??
      data?.duration_ms,
  );
  return duration !== undefined && duration >= 0 ? duration : undefined;
}

function pathsFromLifecycle(payload: ItemLifecycleEvent["payload"]): string[] {
  const taggedDetail = parseTaggedText(payload.detail);
  const { data } = lifecycleRecords(payload);
  const pathKeys = new Set([
    "path",
    "file",
    "filepath",
    "filePath",
    "absolutePath",
    "absolute_path",
    "relativePath",
    "relative_path",
  ]);
  return uniqueStrings([
    ...(taggedDetail.path ? [taggedDetail.path] : []),
    ...(taggedDetail.file ? [taggedDetail.file] : []),
    ...collectStringValues(data, pathKeys),
  ]);
}

function queryFromLifecycle(payload: ItemLifecycleEvent["payload"]): string | undefined {
  const taggedDetail = parseTaggedText(payload.detail);
  const { data, input, args } = lifecycleRecords(payload);
  return firstTrimmedString(
    taggedDetail.query,
    taggedDetail.pattern,
    input?.query,
    input?.pattern,
    input?.regex,
    args?.query,
    args?.pattern,
    args?.regex,
    data?.query,
    data?.pattern,
    data?.regex,
  );
}

function subagentFromLifecycle(
  payload: ItemLifecycleEvent["payload"],
): Record<string, unknown> | undefined {
  const { data, item, input, args, result } = lifecycleRecords(payload);
  const agentId = firstTrimmedString(
    data?.agentId,
    data?.agent_id,
    data?.subagentId,
    data?.subagent_id,
    data?.taskId,
    data?.task_id,
    item?.agentId,
    item?.agent_id,
    item?.subagentId,
    item?.subagent_id,
    input?.agentId,
    input?.agent_id,
    input?.subagentId,
    input?.subagent_id,
    args?.agentId,
    args?.agent_id,
    args?.subagentId,
    args?.subagent_id,
    result?.agentId,
    result?.agent_id,
    result?.subagentId,
    result?.subagent_id,
  );
  const type = firstTrimmedString(
    data?.subagentType,
    data?.subagent_type,
    data?.agentType,
    data?.agent_type,
    data?.agentRole,
    data?.agent_role,
    item?.subagentType,
    item?.subagent_type,
    item?.agentType,
    item?.agent_type,
    item?.agentRole,
    item?.agent_role,
    input?.subagentType,
    input?.subagent_type,
    input?.agentType,
    input?.agent_type,
    input?.agentRole,
    input?.agent_role,
    args?.subagentType,
    args?.subagent_type,
    args?.agentType,
    args?.agent_type,
    args?.agentRole,
    args?.agent_role,
    result?.subagentType,
    result?.subagent_type,
    result?.agentType,
    result?.agent_type,
    result?.agentRole,
    result?.agent_role,
  );
  const name = firstTrimmedString(
    data?.agentDisplayName,
    data?.agent_display_name,
    data?.agentNickname,
    data?.agent_nickname,
    data?.agentName,
    data?.agent_name,
    data?.subagentName,
    data?.subagent_name,
    data?.displayName,
    data?.display_name,
    data?.name,
    item?.agentDisplayName,
    item?.agent_display_name,
    item?.agentNickname,
    item?.agent_nickname,
    item?.agentName,
    item?.agent_name,
    item?.subagentName,
    item?.subagent_name,
    item?.displayName,
    item?.display_name,
    item?.name,
    input?.agentDisplayName,
    input?.agent_display_name,
    input?.agentNickname,
    input?.agent_nickname,
    input?.agentName,
    input?.agent_name,
    input?.subagentName,
    input?.subagent_name,
    input?.displayName,
    input?.display_name,
    input?.name,
    args?.agentDisplayName,
    args?.agent_display_name,
    args?.agentNickname,
    args?.agent_nickname,
    args?.agentName,
    args?.agent_name,
    args?.subagentName,
    args?.subagent_name,
    args?.displayName,
    args?.display_name,
    args?.name,
    result?.agentDisplayName,
    result?.agent_display_name,
    result?.agentNickname,
    result?.agent_nickname,
    result?.agentName,
    result?.agent_name,
    result?.subagentName,
    result?.subagent_name,
    result?.displayName,
    result?.display_name,
    result?.name,
  );
  const description = firstTrimmedString(
    input?.description,
    args?.description,
    data?.description,
    payload.detail,
  );
  const prompt = firstTrimmedString(input?.prompt, args?.prompt, data?.prompt);
  const model = firstTrimmedString(input?.model, args?.model, data?.model);
  if (!agentId && !type && !name && !description && !prompt && !model) {
    return undefined;
  }
  return {
    ...(agentId ? { id: agentId } : {}),
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
  };
}

function inferAction(payload: ItemLifecycleEvent["payload"]): NormalizedToolAction {
  const itemType = payload.itemType;
  if (itemType === "command_execution") {
    return "command";
  }
  if (itemType === "web_search") {
    return "web-search";
  }
  if (itemType === "image_view") {
    return "image-view";
  }
  if (itemType === "mcp_tool_call") {
    return "mcp";
  }
  if (itemType === "collab_agent_tool_call") {
    return "collab-agent";
  }

  const toolLabel = oneLine(
    [toolNameFromLifecycle(payload), payload.itemType].filter(Boolean).join(" "),
  ).toLowerCase();
  if (commandFromLifecycle(payload) || /\b(bash|shell|terminal|exec|command)\b/.test(toolLabel)) {
    return "command";
  }
  if (/\b(read|view|open|cat)\b/.test(toolLabel)) {
    return "file-read";
  }
  if (/\b(edit|write|patch|update|modify|delete|create|rename)\b/.test(toolLabel)) {
    return "file-change";
  }
  if (/\b(search|grep|find|ripgrep|rg)\b/.test(toolLabel)) {
    return "search";
  }
  if (itemType === "file_change") {
    return "file-change";
  }
  return "tool";
}

function itemTypeForAction(
  current: CanonicalItemType,
  action: NormalizedToolAction,
): CanonicalItemType {
  switch (action) {
    case "command":
      return "command_execution";
    case "file-read":
    case "file-change":
      return "file_change";
    case "web-search":
      return "web_search";
    case "image-view":
      return "image_view";
    case "mcp":
      return "mcp_tool_call";
    case "collab-agent":
      return "collab_agent_tool_call";
    case "search":
    case "tool":
    default:
      return isToolLifecycleItemType(current) ? current : "dynamic_tool_call";
  }
}

function titleForAction(input: {
  readonly action: NormalizedToolAction;
  readonly currentTitle?: string | undefined;
  readonly command?: string | undefined;
  readonly subagent?: Record<string, unknown> | undefined;
}): string {
  switch (input.action) {
    case "command":
      return "Run command";
    case "file-read":
      return "Read file";
    case "file-change":
      return "Edit file";
    case "search":
      return "Search";
    case "web-search":
      return "Web search";
    case "image-view":
      return "View image";
    case "mcp":
      return "MCP tool";
    case "collab-agent":
      return "Subagent task";
    case "tool":
    default:
      return input.currentTitle && !/^[.…]$/.test(input.currentTitle)
        ? input.currentTitle
        : "Tool call";
  }
}

function detailForLifecycle(input: {
  readonly payload: ItemLifecycleEvent["payload"];
  readonly action: NormalizedToolAction;
  readonly command?: string | undefined;
  readonly paths: ReadonlyArray<string>;
  readonly query?: string | undefined;
  readonly subagent?: Record<string, unknown> | undefined;
}): string | undefined {
  if (input.action === "command") {
    return input.command;
  }
  if (input.action === "file-read" || input.action === "file-change") {
    return input.paths.length > 0 ? input.paths.slice(0, 3).join("\n") : input.payload.detail;
  }
  if (input.action === "search") {
    return input.query ?? input.payload.detail;
  }
  if (input.action === "collab-agent") {
    return (
      asTrimmedString(input.subagent?.description) ??
      asTrimmedString(input.subagent?.prompt) ??
      asTrimmedString(input.payload.detail)
    );
  }
  const detail = asTrimmedString(input.payload.detail);
  if (!detail || /^[.…]$/.test(detail)) {
    return undefined;
  }
  return detail;
}

function normalizeLifecycleEvent(event: ItemLifecycleEvent): ProviderRuntimeEvent {
  if (!isToolLifecycleItemType(event.payload.itemType) && event.payload.itemType !== "unknown") {
    return event;
  }

  const command = commandFromLifecycle(event.payload);
  const cwd = cwdFromLifecycle(event.payload);
  const output = outputFromLifecycle(event.payload);
  const exitCode = exitCodeFromLifecycle(event.payload);
  const durationMs = durationMsFromLifecycle(event.payload);
  const paths = pathsFromLifecycle(event.payload);
  const query = queryFromLifecycle(event.payload);
  const action = inferAction(event.payload);
  const subagent = action === "collab-agent" ? subagentFromLifecycle(event.payload) : undefined;
  const itemType = itemTypeForAction(event.payload.itemType, action);
  const title = titleForAction({
    action,
    currentTitle: asTrimmedString(event.payload.title),
    command,
    subagent,
  });
  const detail = detailForLifecycle({
    payload: event.payload,
    action,
    command,
    paths,
    query,
    subagent,
  });
  const data = asRecord(event.payload.data) ?? {};
  const ace = asRecord(data.ace);
  const normalizedData: Record<string, unknown> = {
    ...data,
    ace: {
      ...ace,
      normalized: true,
      action,
      itemType,
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(query ? { query } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(subagent ? { subagent } : {}),
    },
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(output ? { output, aggregatedOutput: output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(subagent ? { subagent } : {}),
    ...(paths.length > 0 ? { paths, path: paths[0] } : {}),
    ...(query ? { query } : {}),
  };

  return {
    ...event,
    payload: {
      ...event.payload,
      itemType,
      title,
      ...(detail ? { detail } : {}),
      data: normalizedData,
    },
  } as ProviderRuntimeEvent;
}

export function normalizeProviderRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      return normalizeLifecycleEvent(event);
    default:
      return event;
  }
}
