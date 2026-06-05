import type { CanonicalItemType, ProviderRuntimeEvent } from "@ace/contracts";
import { isToolLifecycleItemType } from "@ace/contracts";
import {
  mergeProviderAgentMetadata,
  providerAgentLooseRecord,
  providerAgentRecord,
} from "@ace/shared/providerAgentMetadata";

type ItemLifecycleEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;
type AuthStatusEvent = Extract<ProviderRuntimeEvent, { type: "auth.status" }>;
type AccountUpdatedEvent = Extract<ProviderRuntimeEvent, { type: "account.updated" }>;
type AccountRateLimitsUpdatedEvent = Extract<
  ProviderRuntimeEvent,
  { type: "account.rate-limits.updated" }
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function firstDefined<T>(...values: ReadonlyArray<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeAuthStatusValue(value: unknown): AuthStatusEvent["payload"]["status"] {
  const normalized = asTrimmedString(value)
    ?.toLowerCase()
    .replace(/[\s_-]+/g, "-");
  switch (normalized) {
    case "authenticated":
    case "logged-in":
    case "signed-in":
    case "ok":
    case "success":
      return "authenticated";
    case "unauthenticated":
    case "not-authenticated":
    case "logged-out":
    case "signed-out":
    case "not-logged-in":
    case "not-signed-in":
    case "missing":
    case "expired":
      return "unauthenticated";
    case "unknown":
    case "warning":
    case "pending":
      return "unknown";
    default:
      return undefined;
  }
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
  const payloadRecord = payload as Record<string, unknown>;
  const metadata = mergeProviderAgentMetadata(
    providerAgentRecord(payloadRecord),
    providerAgentRecord(data),
    providerAgentRecord(item),
    providerAgentRecord(input),
    providerAgentRecord(args),
    providerAgentRecord(result),
    providerAgentLooseRecord(payloadRecord),
    providerAgentLooseRecord(data),
    providerAgentLooseRecord(item),
    providerAgentLooseRecord(input),
    providerAgentLooseRecord(args),
    providerAgentLooseRecord(result),
    providerAgentLooseRecord({ description: payload.detail }),
  );
  const agentId =
    metadata.id ??
    firstTrimmedString(
      data?.taskId,
      data?.task_id,
      item?.taskId,
      item?.task_id,
      input?.taskId,
      input?.task_id,
      args?.taskId,
      args?.task_id,
      result?.taskId,
      result?.task_id,
    );
  const type = metadata.type;
  const name = metadata.name;
  const description = metadata.description;
  const prompt = metadata.prompt;
  const model = metadata.model;
  const transcriptPath = metadata.transcriptPath;
  const lastAssistantMessage = metadata.lastAssistantMessage;
  if (
    !agentId &&
    !type &&
    !name &&
    !description &&
    !prompt &&
    !model &&
    !transcriptPath &&
    !lastAssistantMessage
  ) {
    return undefined;
  }
  return {
    ...(agentId ? { id: agentId } : {}),
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
  };
}

function hasSubagentRoutingSignal(subagent: Record<string, unknown> | undefined): boolean {
  if (!subagent) {
    return false;
  }
  return Boolean(
    asTrimmedString(subagent.id) ??
    asTrimmedString(subagent.type) ??
    asTrimmedString(subagent.name) ??
    asTrimmedString(subagent.prompt) ??
    asTrimmedString(subagent.model),
  );
}

function looksLikeAgentDelegationLabel(toolLabel: string): boolean {
  return (
    /\b(task|subagent|sub-agent|agent|delegate|delegation|handoff|worker|side[-_\s]?(chat|conversation)|btw)\b/.test(
      toolLabel,
    ) || /\b(?:subagent|task)(?:start|stop|created|completed)\b/.test(toolLabel)
  );
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
  const subagent = subagentFromLifecycle(payload);
  if (hasSubagentRoutingSignal(subagent) && looksLikeAgentDelegationLabel(toolLabel)) {
    return "collab-agent";
  }
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

function normalizeAuthStatusEvent(event: AuthStatusEvent): ProviderRuntimeEvent {
  const payload = event.payload as AuthStatusEvent["payload"] & Record<string, unknown>;
  const account = asRecord(payload.account);
  const auth = asRecord(payload.auth);
  const user = asRecord(payload.user);
  const profile = asRecord(payload.profile);
  const isAuthenticated = firstDefined(
    asBoolean(payload.isAuthenticated),
    asBoolean(payload.authenticated),
    asBoolean(auth?.isAuthenticated),
    asBoolean(auth?.authenticated),
  );
  const status =
    payload.status ??
    normalizeAuthStatusValue(payload.authStatus) ??
    normalizeAuthStatusValue(payload.auth_status) ??
    normalizeAuthStatusValue(auth?.status) ??
    normalizeAuthStatusValue(payload.state) ??
    (isAuthenticated === true
      ? "authenticated"
      : isAuthenticated === false
        ? "unauthenticated"
        : undefined);
  const label =
    payload.label ??
    firstTrimmedString(
      payload.login,
      payload.email,
      payload.username,
      payload.user,
      payload.statusMessage,
      payload.status_message,
      payload.message,
      account?.login,
      account?.email,
      account?.username,
      auth?.login,
      auth?.email,
      user?.login,
      user?.email,
      user?.username,
      profile?.login,
      profile?.email,
    );
  const accountPayload =
    account ??
    auth ??
    user ??
    profile ??
    (label
      ? {
          label,
        }
      : undefined);
  const output = Array.isArray(payload.output)
    ? payload.output
    : firstTrimmedString(payload.statusMessage, payload.status_message, payload.message)
      ? [
          firstTrimmedString(
            payload.statusMessage,
            payload.status_message,
            payload.message,
          ) as string,
        ]
      : undefined;

  return {
    ...event,
    payload: {
      ...event.payload,
      ...(status ? { status } : {}),
      ...(label ? { label } : {}),
      ...(accountPayload ? { account: accountPayload } : {}),
      ...(output ? { output } : {}),
    },
  } as ProviderRuntimeEvent;
}

function normalizeAccountUpdatedEvent(event: AccountUpdatedEvent): ProviderRuntimeEvent {
  const payload = event.payload as AccountUpdatedEvent["payload"] & Record<string, unknown>;
  const account = asRecord(payload.account);
  const auth = asRecord(payload.auth);
  const user = asRecord(payload.user);
  const profile = asRecord(payload.profile);
  const subscription = asRecord(payload.subscription);
  const plan = asRecord(payload.plan);
  const label = firstTrimmedString(
    payload.label,
    payload.login,
    payload.email,
    payload.username,
    payload.name,
    payload.accountId,
    payload.account_id,
    account?.label,
    account?.login,
    account?.email,
    account?.username,
    account?.name,
    account?.accountId,
    account?.account_id,
    auth?.login,
    auth?.email,
    user?.login,
    user?.email,
    user?.username,
    user?.name,
    profile?.login,
    profile?.email,
    profile?.username,
    profile?.name,
  );
  const accountPayload =
    account ??
    user ??
    profile ??
    auth ??
    (label
      ? {
          label,
        }
      : payload.account);
  const accountRecord = asRecord(accountPayload);
  const normalizedAccount =
    accountRecord !== undefined
      ? {
          ...accountRecord,
          ...(label ? { label } : {}),
          ...(subscription ? { subscription } : {}),
          ...(plan ? { plan } : {}),
        }
      : accountPayload;

  return {
    ...event,
    payload: {
      ...event.payload,
      account: normalizedAccount,
    },
  } as ProviderRuntimeEvent;
}

function normalizeRateLimitsEvent(event: AccountRateLimitsUpdatedEvent): ProviderRuntimeEvent {
  const payload = event.payload as AccountRateLimitsUpdatedEvent["payload"] &
    Record<string, unknown>;
  const rateLimits =
    payload.rateLimits ??
    payload.rate_limits ??
    payload.rateLimit ??
    payload.rate_limit ??
    payload.limits ??
    payload.quota ??
    payload;
  return {
    ...event,
    payload: {
      ...event.payload,
      rateLimits,
    },
  } as ProviderRuntimeEvent;
}

export function normalizeProviderRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      return normalizeLifecycleEvent(event);
    case "auth.status":
      return normalizeAuthStatusEvent(event);
    case "account.updated":
      return normalizeAccountUpdatedEvent(event);
    case "account.rate-limits.updated":
      return normalizeRateLimitsEvent(event);
    default:
      return event;
  }
}
