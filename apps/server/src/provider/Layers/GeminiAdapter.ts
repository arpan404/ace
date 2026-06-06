import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  isFullAccessRuntimeMode,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionConfigOption,
  type ProviderSessionStartInput,
  type ProviderSlashCommand,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";
import { mergeProviderSlashCommands } from "@ace/shared/providerSlashCommands";
import { resolveProviderSettings } from "@ace/shared/providerInstances";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  acpMultiAgentDefinitionPaths,
  acpMultiAgentInvocationPrefixes,
  acpSideConversationCommands,
  acpSideConversationMethods,
  hasAcpMultiAgentCapability,
  hasAcpSideConversationCapability,
  hasAcpSessionCloseCapability,
  hasAcpSessionForkCapability,
  hasAcpSessionResumeCapability,
} from "../acpCapabilities.ts";
import { meaningfulErrorMessage } from "../errorCause.ts";
import { logWarningEffect, runLoggedEffect } from "../fireAndForget.ts";
import { buildRuntimeErrorPayload } from "../runtimeEventPayloads.ts";
import {
  buildBootstrapPromptFromReplayTurns,
  cloneReplayTurns,
  type TranscriptReplayTurn,
} from "../providerTranscriptBootstrap.ts";
import {
  asArrayOrEmpty as asArray,
  asNonEmptyString as asString,
  asObject,
  asReadonlyArray,
  asRoundedNonNegativeInt,
} from "../unknown.ts";
import {
  AcpRequestError,
  startAcpClient,
  type AcpClient,
  type AcpJsonRpcId,
  type AcpNotification,
  type AcpRequest,
} from "../acpClient.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type GeminiAdapterShape, GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { geminiBuiltInSubagentCommands } from "../providerExtensionSlashCommands.ts";

const PROVIDER = "gemini" as const;
const ACP_CONTROL_TIMEOUT_MS = 20_000;
const ACP_PROTOCOL_VERSION = 1;
const ROLLBACK_BOOTSTRAP_MAX_CHARS = 24_000;
const GEMINI_PLAN_FILE_MAX_BYTES = 1_000_000;
const GEMINI_PLAN_FILE_MTIME_MARGIN_MS = 5_000;
export const GEMINI_ACP_CLIENT_INFO = {
  name: "ace",
  version: "1.0.17",
} as const;

export type GeminiAcpMcpServer =
  | {
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<{
        readonly name: string;
        readonly value: string;
      }>;
    }
  | {
      readonly name: string;
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers: ReadonlyArray<{
        readonly name: string;
        readonly value: string;
      }>;
    };

export function buildGeminiInitializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientInfo: GEMINI_ACP_CLIENT_INFO,
    clientCapabilities: {
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
    },
  };
}

function normalizeGeminiMcpStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeGeminiMcpStringMap(
  value: unknown,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  const record = asObject(value);
  if (!record) {
    return [];
  }
  return Object.entries(record)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].trim().length > 0 && typeof entry[1] === "string",
    )
    .map(([name, value]) => ({ name, value }));
}

function normalizeGeminiAcpMcpServer(name: string, value: unknown): GeminiAcpMcpServer | null {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }
  const server = asObject(value);
  if (!server) {
    return null;
  }
  const httpUrl = asString(server.httpUrl);
  if (httpUrl) {
    return {
      name: normalizedName,
      type: "http",
      url: httpUrl,
      headers: normalizeGeminiMcpStringMap(server.headers),
    };
  }
  const sseUrl = asString(server.url);
  if (sseUrl) {
    return {
      name: normalizedName,
      type: "sse",
      url: sseUrl,
      headers: normalizeGeminiMcpStringMap(server.headers),
    };
  }
  const command = asString(server.command);
  if (!command) {
    return null;
  }
  return {
    name: normalizedName,
    command,
    args: normalizeGeminiMcpStringArray(server.args),
    env: normalizeGeminiMcpStringMap(server.env),
  };
}

export function buildGeminiAcpMcpServersFromSettings(
  settings: ReadonlyArray<Record<string, unknown> | null | undefined>,
): GeminiAcpMcpServer[] {
  const serversByName = new Map<string, GeminiAcpMcpServer>();
  for (const settingsRecord of settings) {
    const mcpServers = asObject(settingsRecord?.mcpServers);
    if (!mcpServers) {
      continue;
    }
    for (const [name, value] of Object.entries(mcpServers)) {
      const server = normalizeGeminiAcpMcpServer(name, value);
      if (server) {
        serversByName.set(server.name, server);
      }
    }
  }
  return [...serversByName.values()];
}

function geminiConfiguredMcpStatus(
  mcpServers: ReadonlyArray<GeminiAcpMcpServer>,
): ReadonlyArray<GeminiAcpMcpServer & { readonly status: "configured" }> {
  return mcpServers.map((server) => Object.assign({}, server, { status: "configured" as const }));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const fileStat = await stat(file);
    return fileStat.isFile() || fileStat.isDirectory();
  } catch {
    return false;
  }
}

async function nearestGitRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  while (true) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function geminiProjectSettingsFiles(cwd: string): Promise<string[]> {
  const root = await nearestGitRoot(cwd);
  const limit = root ?? path.parse(path.resolve(cwd)).root;
  const files: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    files.unshift(path.join(current, ".gemini", "settings.json"));
    if (current === limit) {
      return files;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return files;
    }
    current = parent;
  }
}

function parseGeminiSettings(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readGeminiSettingsRecord(file: string): Promise<Record<string, unknown> | null> {
  try {
    return parseGeminiSettings(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readGeminiAcpMcpServers(input: {
  readonly cwd: string;
  readonly geminiHome?: string | undefined;
}): Promise<GeminiAcpMcpServer[]> {
  const homeSettings = path.join(resolveGeminiHome(input.geminiHome), "settings.json");
  const settingsFiles = [homeSettings, ...(await geminiProjectSettingsFiles(input.cwd))];
  const settings = await Promise.all(settingsFiles.map((file) => readGeminiSettingsRecord(file)));
  return buildGeminiAcpMcpServersFromSettings(settings);
}

function resolveGeminiHome(geminiHome?: string | undefined): string {
  return geminiHome?.trim() || path.join(homedir(), ".gemini");
}

async function ensureGeminiProjectRegistry(geminiHome?: string | undefined): Promise<void> {
  const home = resolveGeminiHome(geminiHome);
  const registryFile = path.join(home, "projects.json");
  const defaultRegistry = { projects: {} };
  let raw: string;
  try {
    raw = await readFile(registryFile, "utf8");
  } catch {
    await mkdir(home, { recursive: true });
    await writeFile(registryFile, `${JSON.stringify(defaultRegistry, null, 2)}\n`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await writeFile(registryFile, `${JSON.stringify(defaultRegistry, null, 2)}\n`);
    return;
  }
  const record = parsed as Record<string, unknown>;
  if (!record.projects || typeof record.projects !== "object" || Array.isArray(record.projects)) {
    await writeFile(registryFile, `${JSON.stringify({ ...record, projects: {} }, null, 2)}\n`);
  }
}

export function canGeminiSetSessionMode(metadata: Pick<GeminiSessionMetadata, "availableModes">) {
  return metadata.availableModes.length > 0;
}

export function canGeminiSetSessionModel(metadata: Pick<GeminiSessionMetadata, "availableModels">) {
  return metadata.availableModels.length > 0;
}

type GeminiLaunchApprovalMode = "default" | "yolo" | "plan";

export function geminiLaunchApprovalModeForSession(
  runtimeMode: ProviderSession["runtimeMode"],
  interactionMode?: ProviderSendTurnInput["interactionMode"],
): GeminiLaunchApprovalMode {
  if (interactionMode === "plan") {
    return "plan";
  }
  return isFullAccessRuntimeMode(runtimeMode) ? "yolo" : "default";
}

export function buildGeminiAcpArgAttempts(
  approvalMode: GeminiLaunchApprovalMode,
): ReadonlyArray<ReadonlyArray<string>> {
  const modeArg = `--approval-mode=${approvalMode}`;
  const trustArg = "--skip-trust";
  const withApprovalMode: Array<ReadonlyArray<string>> = [
    ["--acp", modeArg],
    ["--experimental-acp", modeArg],
  ];

  if (approvalMode !== "default") {
    withApprovalMode.unshift(
      ["--acp", trustArg, modeArg],
      ["--experimental-acp", trustArg, modeArg],
    );
  }

  if (approvalMode !== "plan") {
    return withApprovalMode;
  }

  // Plan is a launch-time policy in current Gemini CLI builds. Starting plain
  // ACP after these attempts fail would create a non-plan session that cannot
  // enforce Plan Mode safely.
  return withApprovalMode;
}

function shouldAutoResolveGeminiPermission(runtimeMode: ProviderSession["runtimeMode"]): boolean {
  return isFullAccessRuntimeMode(runtimeMode);
}

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

type ProviderRuntimeEventByType<TType extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: TType }
>;

type GeminiPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
type GeminiToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
type GeminiToolStatus = "pending" | "in_progress" | "completed" | "failed";
type GeminiToolItemType =
  | "command_execution"
  | "file_change"
  | "dynamic_tool_call"
  | "collab_agent_tool_call";

type GeminiMode = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

type GeminiModel = {
  readonly modelId: string;
  readonly name?: string;
  readonly description?: string;
};

type GeminiAuthMethod = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
};

type GeminiToolLocation = {
  readonly path: string;
  readonly line?: number | null;
};

type GeminiTextContent = {
  readonly type: "text";
  readonly text: string;
};

type GeminiResourceLinkContent = {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string | null;
  readonly size?: number | null;
  readonly description?: string | null;
};

type GeminiPromptContent = GeminiTextContent | GeminiResourceLinkContent;

type GeminiToolCallContent =
  | {
      readonly type: "content";
      readonly content?: {
        readonly type?: string;
        readonly text?: string;
      };
    }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
    }
  | {
      readonly type: "terminal";
      readonly terminalId: string;
    };

type GeminiToolCallLike = {
  readonly toolCallId: string;
  readonly status?: GeminiToolStatus;
  readonly title?: string;
  readonly kind?: GeminiToolKind;
  readonly content?: ReadonlyArray<GeminiToolCallContent>;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly locations?: ReadonlyArray<GeminiToolLocation>;
};

type GeminiSessionMetadata = {
  readonly authMethods: ReadonlyArray<GeminiAuthMethod>;
  readonly loadSession: boolean;
  readonly resumeSession: boolean;
  readonly closeSession: boolean;
  readonly forkSession: boolean;
  readonly sideConversation: boolean;
  readonly sideConversationCommands: ReadonlyArray<string>;
  readonly sideConversationMethods: ReadonlyArray<string>;
  readonly multiAgent: boolean;
  readonly multiAgentInvocationPrefixes: ReadonlyArray<string>;
  readonly multiAgentDefinitionPaths: ReadonlyArray<string>;
  builtInSubagentCommands: ReadonlyArray<ProviderSlashCommand>;
  availableCommands: ReadonlyArray<GeminiAvailableCommand>;
  availableModes: ReadonlyArray<GeminiMode>;
  currentModeId?: string;
  availableModels: ReadonlyArray<GeminiModel>;
  currentModelId?: string;
};

type GeminiAvailableCommand = {
  readonly name: string;
  readonly description?: string;
  readonly input?: {
    readonly hint?: string;
  };
};

function geminiProviderSlashCommands(
  commands: ReadonlyArray<GeminiAvailableCommand>,
  builtInSubagentCommands: ReadonlyArray<ProviderSlashCommand>,
): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
    })),
    builtInSubagentCommands,
  );
}

function buildGeminiSessionConfigOptions(
  metadata: GeminiSessionMetadata,
): ReadonlyArray<ProviderSessionConfigOption> {
  if (metadata.availableModes.length === 0) {
    return [];
  }
  const currentValue = metadata.currentModeId ?? metadata.availableModes[0]?.id;
  if (!currentValue) {
    return [];
  }
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: metadata.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name ?? mode.id,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    },
  ];
}

function geminiSessionConfigSnapshot(metadata: GeminiSessionMetadata): Record<string, unknown> {
  return {
    availableCommands: geminiProviderSlashCommands(
      metadata.availableCommands,
      metadata.builtInSubagentCommands,
    ),
    configOptions: buildGeminiSessionConfigOptions(metadata),
    capabilities: geminiProviderCapabilities(metadata),
  };
}

type GeminiToolItemState = {
  readonly itemId: RuntimeItemId;
  itemType: GeminiToolItemType;
  completed: boolean;
};

type GeminiTurnState = {
  readonly id: TurnId;
  started: boolean;
  readonly startedAtMs: number;
  readonly inputText: string;
  readonly attachmentNames: ReadonlyArray<string>;
  assistantText: string;
  lastProposedPlanMarkdown?: string;
  readonly items: Array<unknown>;
  readonly assistantItemId: RuntimeItemId;
  assistantStarted: boolean;
  readonly reasoningItemId: RuntimeItemId;
  reasoningStarted: boolean;
  readonly toolItems: Map<string, GeminiToolItemState>;
  interruptedRequested: boolean;
};

type GeminiPendingPermission = {
  readonly jsonRpcId: AcpJsonRpcId;
  readonly requestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly requestType: ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"];
  readonly options: ReadonlyArray<{
    readonly optionId: string;
    readonly name: string;
    readonly kind: GeminiPermissionOptionKind;
  }>;
  readonly toolCallId: string;
};

type GeminiPendingUserInput = {
  readonly jsonRpcId: AcpJsonRpcId;
  readonly requestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
};

type GeminiContextUsageSnapshot = {
  readonly usedTokens: number;
  readonly maxTokens?: number;
  readonly totalProcessedTokens?: number;
};

type GeminiSessionContext = {
  readonly threadId: ThreadId;
  readonly client: AcpClient;
  readonly sessionId: string;
  session: ProviderSession;
  metadata: GeminiSessionMetadata;
  readonly launchApprovalModeApplied?: GeminiLaunchApprovalMode;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly replayTurns: Array<TranscriptReplayTurn>;
  readonly sequenceTieBreakersByTimestampMs: Map<number, number>;
  nextFallbackSessionSequence: number;
  activeTurn: GeminiTurnState | null;
  readonly pendingPermissions: Map<string, GeminiPendingPermission>;
  readonly pendingUserInputs: Map<string, GeminiPendingUserInput>;
  lastUsageSnapshot?: GeminiContextUsageSnapshot;
  totalProcessedTokens: number;
  pendingBootstrapReset: boolean;
  closed: boolean;
  stopRequested: boolean;
};

type GeminiOutcome =
  | {
      readonly state: "completed" | "interrupted";
      readonly stopReason?: string | null;
      readonly usage?: unknown;
    }
  | {
      readonly state: "failed";
      readonly stopReason?: string | null;
      readonly errorMessage: string;
      readonly usage?: unknown;
    };

function isoNow(): string {
  return new Date().toISOString();
}

function parseIsoTimestampMs(value: string): number | undefined {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  return meaningfulErrorMessage(cause, fallback);
}

function firstRoundedNonNegativeInt(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): number | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = asRoundedNonNegativeInt(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

type GeminiTokenCountTotals = {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

function readGeminiTokenCountRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(record?.token_count) ?? asObject(record?.tokenCount);
}

function readGeminiModelUsageTotals(value: unknown): GeminiTokenCountTotals | undefined {
  const modelUsage = asArray(value);
  let inputTokens = 0;
  let outputTokens = 0;
  let foundTokens = false;

  for (const entry of modelUsage) {
    const tokenCount = readGeminiTokenCountRecord(asObject(entry));
    const inputTokenCount = firstRoundedNonNegativeInt(tokenCount, ["input_tokens", "inputTokens"]);
    const outputTokenCount = firstRoundedNonNegativeInt(tokenCount, [
      "output_tokens",
      "outputTokens",
    ]);

    if (inputTokenCount !== undefined) {
      inputTokens += inputTokenCount;
      foundTokens = true;
    }
    if (outputTokenCount !== undefined) {
      outputTokens += outputTokenCount;
      foundTokens = true;
    }
  }

  if (!foundTokens) {
    return undefined;
  }

  const totalTokens = inputTokens + outputTokens;
  return {
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
  };
}

function readGeminiTokenCountTotals(value: unknown): GeminiTokenCountTotals | undefined {
  const record = asObject(value);
  const tokenCount = readGeminiTokenCountRecord(record);
  const modelUsageTotals = readGeminiModelUsageTotals(record?.model_usage ?? record?.modelUsage);

  const inputTokens =
    firstRoundedNonNegativeInt(tokenCount, ["input_tokens", "inputTokens"]) ??
    modelUsageTotals?.inputTokens;
  const cachedReadTokens = firstRoundedNonNegativeInt(tokenCount, [
    "cached_read_tokens",
    "cachedReadTokens",
  ]);
  const cachedWriteTokens = firstRoundedNonNegativeInt(tokenCount, [
    "cached_write_tokens",
    "cachedWriteTokens",
  ]);
  const outputTokens =
    firstRoundedNonNegativeInt(tokenCount, ["output_tokens", "outputTokens"]) ??
    modelUsageTotals?.outputTokens;
  const reasoningOutputTokens = firstRoundedNonNegativeInt(tokenCount, [
    "thought_tokens",
    "thoughtTokens",
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ]);
  const derivedTotalTokens =
    (inputTokens ?? 0) +
    (cachedReadTokens ?? 0) +
    (cachedWriteTokens ?? 0) +
    (outputTokens ?? 0) +
    (reasoningOutputTokens ?? 0);
  const totalTokens =
    firstRoundedNonNegativeInt(tokenCount, ["total_tokens", "totalTokens"]) ??
    (derivedTotalTokens > 0 ? derivedTotalTokens : undefined) ??
    modelUsageTotals?.totalTokens;

  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cachedReadTokens === undefined &&
    cachedWriteTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

function geminiToolUseCount(turn: GeminiTurnState | null): number | undefined {
  const count = turn?.toolItems.size ?? 0;
  return count > 0 ? count : undefined;
}

function buildGeminiContextUsageSnapshot(
  value: unknown,
  turn: GeminiTurnState | null,
):
  | (ProviderRuntimeEventByType<"thread.token-usage.updated">["payload"]["usage"] &
      GeminiContextUsageSnapshot)
  | undefined {
  const record = asObject(value);
  const usageMetadata = asObject(record?.usageMetadata) ?? asObject(record?.usage_metadata);
  const usedTokens =
    firstRoundedNonNegativeInt(record, [
      "used",
      "currentTokens",
      "current_tokens",
      "usedTokens",
      "used_tokens",
      "promptTokenCount",
      "prompt_token_count",
      "lastPromptTokenCount",
      "last_prompt_token_count",
    ]) ??
    firstRoundedNonNegativeInt(usageMetadata, [
      "used",
      "currentTokens",
      "current_tokens",
      "usedTokens",
      "used_tokens",
      "promptTokenCount",
      "prompt_token_count",
      "lastPromptTokenCount",
      "last_prompt_token_count",
    ]);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    firstRoundedNonNegativeInt(record, [
      "size",
      "maxTokens",
      "max_tokens",
      "contextWindow",
      "context_window",
      "maxContextWindowTokens",
      "max_context_window_tokens",
      "tokenLimit",
      "token_limit",
      "limit",
    ]) ??
    firstRoundedNonNegativeInt(usageMetadata, [
      "size",
      "maxTokens",
      "max_tokens",
      "contextWindow",
      "context_window",
      "maxContextWindowTokens",
      "max_context_window_tokens",
      "tokenLimit",
      "token_limit",
      "limit",
    ]);
  const toolUses = geminiToolUseCount(turn);

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(toolUses !== undefined ? { toolUses } : {}),
  };
}

function buildGeminiTurnUsageSnapshot(
  value: unknown,
  turn: GeminiTurnState,
  lastUsageSnapshot: GeminiContextUsageSnapshot | undefined,
): ProviderRuntimeEventByType<"thread.token-usage.updated">["payload"]["usage"] | undefined {
  const record = asObject(value);
  const tokenCountTotals = readGeminiTokenCountTotals(record);
  const finalContextUsage = buildGeminiContextUsageSnapshot(value, turn);
  const totalTokens =
    firstRoundedNonNegativeInt(record, ["totalTokens", "total_tokens", "totalTokenCount"]) ??
    tokenCountTotals?.totalTokens;
  const inputTokens =
    firstRoundedNonNegativeInt(record, [
      "inputTokens",
      "input_tokens",
      "promptTokenCount",
      "prompt_token_count",
    ]) ?? tokenCountTotals?.inputTokens;
  const cachedReadTokens =
    firstRoundedNonNegativeInt(record, ["cachedReadTokens", "cached_read_tokens"]) ??
    tokenCountTotals?.cachedReadTokens;
  const cachedWriteTokens =
    firstRoundedNonNegativeInt(record, ["cachedWriteTokens", "cached_write_tokens"]) ??
    tokenCountTotals?.cachedWriteTokens;
  const outputTokens =
    firstRoundedNonNegativeInt(record, [
      "outputTokens",
      "output_tokens",
      "candidatesTokenCount",
      "candidates_token_count",
    ]) ?? tokenCountTotals?.outputTokens;
  const reasoningOutputTokens =
    firstRoundedNonNegativeInt(record, [
      "thoughtTokens",
      "thought_tokens",
      "thoughtsTokenCount",
      "thoughts_token_count",
      "reasoningTokens",
      "reasoning_tokens",
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ]) ?? tokenCountTotals?.reasoningOutputTokens;
  const durationMs = firstRoundedNonNegativeInt(record, ["durationMs", "duration", "duration_ms"]);
  const cachedInputTokens =
    (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0) > 0
      ? (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
      : undefined;
  const toolUses = geminiToolUseCount(turn);
  const hasDetails =
    finalContextUsage !== undefined ||
    totalTokens !== undefined ||
    inputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    outputTokens !== undefined ||
    reasoningOutputTokens !== undefined ||
    durationMs !== undefined ||
    toolUses !== undefined;

  if (!hasDetails) {
    return undefined;
  }

  const contextUsedTokens = lastUsageSnapshot?.usedTokens ?? finalContextUsage?.usedTokens;
  const usedTokens = contextUsedTokens ?? totalTokens;
  const maxTokens = lastUsageSnapshot?.maxTokens ?? finalContextUsage?.maxTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(totalTokens !== undefined && totalTokens > 0
      ? { lastUsedTokens: totalTokens }
      : finalContextUsage?.lastUsedTokens !== undefined
        ? { lastUsedTokens: finalContextUsage.lastUsedTokens }
        : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0
      ? { lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined && reasoningOutputTokens > 0
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    ...(toolUses !== undefined
      ? { toolUses }
      : finalContextUsage?.toolUses !== undefined
        ? { toolUses: finalContextUsage.toolUses }
        : {}),
  };
}

function readGeminiProcessedTokens(value: unknown): number | undefined {
  const record = asObject(value);
  const tokenCountTotals = readGeminiTokenCountTotals(record);
  const totalTokens =
    firstRoundedNonNegativeInt(record, ["totalTokens", "total_tokens"]) ??
    tokenCountTotals?.totalTokens;
  if (totalTokens !== undefined && totalTokens > 0) {
    return totalTokens;
  }

  const inputTokens =
    firstRoundedNonNegativeInt(record, ["inputTokens", "input_tokens"]) ??
    tokenCountTotals?.inputTokens;
  const cachedReadTokens =
    firstRoundedNonNegativeInt(record, ["cachedReadTokens", "cached_read_tokens"]) ??
    tokenCountTotals?.cachedReadTokens;
  const cachedWriteTokens =
    firstRoundedNonNegativeInt(record, ["cachedWriteTokens", "cached_write_tokens"]) ??
    tokenCountTotals?.cachedWriteTokens;
  const outputTokens =
    firstRoundedNonNegativeInt(record, ["outputTokens", "output_tokens"]) ??
    tokenCountTotals?.outputTokens;
  const reasoningOutputTokens =
    firstRoundedNonNegativeInt(record, [
      "thoughtTokens",
      "thought_tokens",
      "reasoningTokens",
      "reasoning_tokens",
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ]) ?? tokenCountTotals?.reasoningOutputTokens;
  const derivedTotal =
    (inputTokens ?? 0) +
    (cachedReadTokens ?? 0) +
    (cachedWriteTokens ?? 0) +
    (outputTokens ?? 0) +
    (reasoningOutputTokens ?? 0);

  return derivedTotal > 0 ? derivedTotal : undefined;
}

function resolveGeminiNotificationCreatedAt(
  params: Record<string, unknown>,
  update: Record<string, unknown>,
): string | undefined {
  return (
    asString(update.createdAt) ??
    asString(update.timestamp) ??
    asString(update.updatedAt) ??
    asString(params.createdAt) ??
    asString(params.timestamp)
  );
}

function normalizeSessionModes(value: unknown): {
  readonly availableModes: ReadonlyArray<GeminiMode>;
  readonly currentModeId?: string;
} {
  const record = asObject(value);
  const availableModes = asArray(record?.availableModes)
    .map((entry) => {
      const mode = asObject(entry);
      const id = asString(mode?.id);
      const name = asString(mode?.name);
      const description = asString(mode?.description);
      if (!id) {
        return null;
      }
      const normalizedMode: { id: string; name?: string; description?: string } = { id };
      if (name) {
        normalizedMode.name = name;
      }
      if (description) {
        normalizedMode.description = description;
      }
      return normalizedMode;
    })
    .filter((entry): entry is GeminiMode => entry !== null);
  const currentModeId = asString(record?.currentModeId);
  return currentModeId ? { availableModes, currentModeId } : { availableModes };
}

function normalizeSessionModels(value: unknown): {
  readonly availableModels: ReadonlyArray<GeminiModel>;
  readonly currentModelId?: string;
} {
  const record = asObject(value);
  const availableModels = asArray(record?.availableModels)
    .map((entry) => {
      const model = asObject(entry);
      const modelId = asString(model?.modelId);
      const name = asString(model?.name);
      const description = asString(model?.description);
      if (!modelId) {
        return null;
      }
      const normalizedModel: { modelId: string; name?: string; description?: string } = { modelId };
      if (name) {
        normalizedModel.name = name;
      }
      if (description) {
        normalizedModel.description = description;
      }
      return normalizedModel;
    })
    .filter((entry): entry is GeminiModel => entry !== null);
  const currentModelId = asString(record?.currentModelId);
  return currentModelId ? { availableModels, currentModelId } : { availableModels };
}

function readAvailableCommandEntries(value: unknown): ReadonlyArray<unknown> | null {
  const valueRecord = asObject(value);
  return (
    asReadonlyArray(value) ??
    asReadonlyArray(valueRecord?.commands) ??
    asReadonlyArray(valueRecord?.availableCommands) ??
    asReadonlyArray(valueRecord?.available_commands) ??
    null
  );
}

function normalizeAvailableCommands(value: unknown): ReadonlyArray<GeminiAvailableCommand> {
  const commands = readAvailableCommandEntries(value) ?? [];
  return commands
    .map((entry) => {
      const command = asObject(entry);
      const name = asString(command?.name);
      if (!name) {
        return null;
      }
      const description = asString(command?.description);
      const input = asObject(command?.input);
      const inputHint = asString(input?.hint);
      const normalized: { name: string; description?: string; input?: { hint?: string } } = {
        name,
      };
      if (description) {
        normalized.description = description;
      }
      if (inputHint) {
        normalized.input = { hint: inputHint };
      }
      return normalized;
    })
    .filter((entry): entry is GeminiAvailableCommand => entry !== null);
}

function normalizeInitializeResponse(value: unknown): GeminiSessionMetadata {
  const record = asObject(value);
  const authMethods = asArray(record?.authMethods)
    .map((entry) => {
      const method = asObject(entry);
      const id = asString(method?.id);
      const name = asString(method?.name);
      const description = asString(method?.description);
      const type = asString(method?.type);
      if (!id) {
        return null;
      }
      const normalizedMethod: {
        id: string;
        name?: string;
        description?: string;
        type?: string;
      } = { id };
      if (name) {
        normalizedMethod.name = name;
      }
      if (description) {
        normalizedMethod.description = description;
      }
      if (type) {
        normalizedMethod.type = type;
      }
      return normalizedMethod;
    })
    .filter((entry): entry is GeminiAuthMethod => entry !== null);
  const agentCapabilities = asObject(record?.agentCapabilities);
  return {
    authMethods,
    loadSession: agentCapabilities?.loadSession === true,
    resumeSession: hasAcpSessionResumeCapability(value),
    closeSession: hasAcpSessionCloseCapability(value),
    forkSession: hasAcpSessionForkCapability(value),
    sideConversation: hasAcpSideConversationCapability(value),
    sideConversationCommands: acpSideConversationCommands(value),
    sideConversationMethods: acpSideConversationMethods(value),
    multiAgent: hasAcpMultiAgentCapability(value),
    multiAgentInvocationPrefixes: acpMultiAgentInvocationPrefixes(value),
    multiAgentDefinitionPaths: acpMultiAgentDefinitionPaths(value),
    builtInSubagentCommands: [],
    availableCommands: normalizeAvailableCommands(record?.availableCommands),
    availableModes: [],
    availableModels: [],
  };
}

function geminiProviderCapabilities(
  metadata: Pick<
    GeminiSessionMetadata,
    | "forkSession"
    | "resumeSession"
    | "sideConversation"
    | "sideConversationCommands"
    | "sideConversationMethods"
    | "multiAgent"
    | "multiAgentInvocationPrefixes"
    | "multiAgentDefinitionPaths"
  >,
) {
  return {
    sessionResumeMode: metadata.resumeSession ? ("native" as const) : ("local-replay" as const),
    sessionForkMode: metadata.forkSession ? ("native" as const) : ("local-replay" as const),
    sideConversationMode: metadata.forkSession
      ? ("native-fork" as const)
      : metadata.sideConversationMethods.length > 0
        ? ("native-side-thread" as const)
        : ("replay-fork" as const),
    ...(metadata.sideConversationCommands.length > 0
      ? { sideConversationCommands: metadata.sideConversationCommands }
      : {}),
    ...(metadata.multiAgent ? { multiAgentMode: "native" as const } : {}),
    ...(metadata.multiAgentInvocationPrefixes.length > 0
      ? { multiAgentInvocationPrefixes: metadata.multiAgentInvocationPrefixes }
      : {}),
    ...(metadata.multiAgentDefinitionPaths.length > 0
      ? { multiAgentDefinitionPaths: metadata.multiAgentDefinitionPaths }
      : {}),
  };
}

function updateMetadataFromSessionResult(
  metadata: GeminiSessionMetadata,
  result: unknown,
): GeminiSessionMetadata {
  const record = asObject(result);
  const modes = normalizeSessionModes(record?.modes);
  const models = normalizeSessionModels(record?.models);
  const availableCommandEntries = readAvailableCommandEntries(record?.availableCommands);
  return {
    ...metadata,
    availableCommands:
      availableCommandEntries !== null
        ? normalizeAvailableCommands(availableCommandEntries)
        : metadata.availableCommands,
    availableModes: modes.availableModes,
    ...(modes.currentModeId ? { currentModeId: modes.currentModeId } : {}),
    availableModels: models.availableModels,
    ...(models.currentModelId ? { currentModelId: models.currentModelId } : {}),
  };
}

function readGeminiResumeCursor(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.length > 0) {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  return asString((resumeCursor as Record<string, unknown>).sessionId);
}

function isGeminiAuthRequiredError(cause: unknown): boolean {
  if (!(cause instanceof AcpRequestError)) {
    return false;
  }
  const message = cause.message.toLowerCase();
  return cause.code === -32000 && message.includes("authentication required");
}

function isMissingGeminiSessionError(cause: unknown): boolean {
  const message = toMessage(cause, "").toLowerCase();
  return (
    message.includes("session not found") ||
    message.includes("unknown session") ||
    (message.includes("not found") && message.includes("session"))
  );
}

function preferredAuthMethod(
  authMethods: ReadonlyArray<GeminiAuthMethod>,
  env: NodeJS.ProcessEnv = process.env,
): { readonly methodId: string; readonly meta?: Record<string, unknown> } | undefined {
  const find = (id: string) => authMethods.find((method) => method.id === id);

  if (env.GEMINI_API_KEY && find("gemini-api-key")) {
    return {
      methodId: "gemini-api-key",
      meta: {
        "api-key": env.GEMINI_API_KEY,
      },
    };
  }
  if (env.GOOGLE_GENAI_USE_VERTEXAI?.toLowerCase() === "true" && find("vertex-ai")) {
    return { methodId: "vertex-ai" };
  }
  if (env.GOOGLE_GENAI_USE_GCA?.toLowerCase() === "true" && find("oauth-personal")) {
    return { methodId: "oauth-personal" };
  }
  return undefined;
}

function describeGeminiAuthRequirement(metadata: GeminiSessionMetadata): string {
  const apiKeySupported = metadata.authMethods.some((method) => method.id === "gemini-api-key");
  return apiKeySupported
    ? "Gemini CLI requires authentication. Configure `GEMINI_API_KEY` or sign in with the Gemini CLI before starting a session."
    : "Gemini CLI requires authentication before starting a session.";
}

function normalizeModeLabel(mode: GeminiMode): string {
  return `${mode.id} ${mode.name ?? ""} ${mode.description ?? ""}`.toLowerCase();
}

function resolveDesiredModeId(
  metadata: GeminiSessionMetadata,
  runtimeMode: ProviderSession["runtimeMode"],
  interactionMode: ProviderSendTurnInput["interactionMode"],
): string | undefined {
  const availableModes = metadata.availableModes;
  if (availableModes.length === 0) {
    return undefined;
  }
  const planMode = availableModes.find((mode) => normalizeModeLabel(mode).includes("plan"));
  const yoloMode = availableModes.find((mode) => {
    const label = normalizeModeLabel(mode);
    return label.includes("yolo") || label.includes("auto-approves all");
  });
  const defaultMode = availableModes.find((mode) => {
    const label = normalizeModeLabel(mode);
    return label.includes("default") || label.includes("prompts for approval");
  });
  const permissiveMode = availableModes.find((mode) => {
    const label = normalizeModeLabel(mode);
    return label.includes("auto-approves");
  });
  const fallbackMode = availableModes.find((mode) => !normalizeModeLabel(mode).includes("plan"));

  if (interactionMode === "plan") {
    return planMode?.id;
  }
  if (isFullAccessRuntimeMode(runtimeMode)) {
    return yoloMode?.id ?? permissiveMode?.id ?? fallbackMode?.id;
  }
  return defaultMode?.id ?? fallbackMode?.id ?? availableModes[0]?.id;
}

function explicitGeminiModeId(
  modelSelection:
    | ProviderSessionStartInput["modelSelection"]
    | ProviderSendTurnInput["modelSelection"]
    | undefined,
): string | undefined {
  return modelSelection?.provider === PROVIDER ? modelSelection.options?.modeId?.trim() : undefined;
}

function runtimeItemTypeFromToolKind(kind?: GeminiToolKind | null): GeminiToolItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function geminiSubagentMetadata(
  toolCall: GeminiToolCallLike,
):
  | { id: string; type?: string | undefined; name?: string | undefined; model?: string | undefined }
  | undefined {
  const rawInput = asObject(toolCall.rawInput);
  const rawOutput = asObject(toolCall.rawOutput);
  const agentId = firstString(
    rawInput?.agentId,
    rawInput?.agent_id,
    rawInput?.subagentId,
    rawInput?.subagent_id,
    rawInput?.agent,
    rawInput?.agentName,
    rawInput?.agent_name,
    rawOutput?.agentId,
    rawOutput?.agent_id,
    rawOutput?.subagentId,
    rawOutput?.subagent_id,
    rawOutput?.agent,
    rawOutput?.agentName,
    rawOutput?.agent_name,
  );
  const label = [toolCall.kind, toolCall.title, agentId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  const hasExplicitSubagentField =
    agentId !== undefined ||
    rawInput?.subagent !== undefined ||
    rawInput?.subagentType !== undefined ||
    rawInput?.subagent_type !== undefined ||
    rawInput?.agentRole !== undefined ||
    rawInput?.agent_role !== undefined ||
    rawOutput?.subagent !== undefined ||
    rawOutput?.subagentType !== undefined ||
    rawOutput?.subagent_type !== undefined ||
    rawOutput?.agentRole !== undefined ||
    rawOutput?.agent_role !== undefined;
  const looksLikeSubagent =
    hasExplicitSubagentField ||
    label.includes("subagent") ||
    label.includes("sub-agent") ||
    label.includes("agent");
  if (!looksLikeSubagent) {
    return undefined;
  }
  const name = firstString(
    rawInput?.agentDisplayName,
    rawInput?.agent_display_name,
    rawInput?.agentNickname,
    rawInput?.agent_nickname,
    rawInput?.subagentName,
    rawInput?.subagent_name,
    rawInput?.agentName,
    rawInput?.agent_name,
    rawInput?.agent,
    rawOutput?.agentDisplayName,
    rawOutput?.agent_display_name,
    rawOutput?.agentNickname,
    rawOutput?.agent_nickname,
    rawOutput?.subagentName,
    rawOutput?.subagent_name,
    rawOutput?.agentName,
    rawOutput?.agent_name,
    rawOutput?.agent,
    toolCall.title,
  );
  const type = firstString(
    rawInput?.subagentType,
    rawInput?.subagent_type,
    rawInput?.agentRole,
    rawInput?.agent_role,
    rawInput?.agentType,
    rawInput?.agent_type,
    rawOutput?.subagentType,
    rawOutput?.subagent_type,
    rawOutput?.agentRole,
    rawOutput?.agent_role,
    rawOutput?.agentType,
    rawOutput?.agent_type,
  );
  const model = firstString(rawInput?.model, rawOutput?.model);
  return {
    id: agentId ?? toolCall.toolCallId,
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
  };
}

function runtimeItemTypeFromToolCall(toolCall: GeminiToolCallLike): GeminiToolItemType {
  return geminiSubagentMetadata(toolCall)
    ? "collab_agent_tool_call"
    : runtimeItemTypeFromToolKind(toolCall.kind);
}

function requestTypeFromToolKind(
  kind?: GeminiToolKind | null,
): ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"] {
  switch (kind) {
    case "execute":
      return "command_execution_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

function mapPlanStatus(value: string | undefined): "pending" | "inProgress" | "completed" {
  switch (value) {
    case "completed":
      return "completed";
    case "in_progress":
      return "inProgress";
    default:
      return "pending";
  }
}

type GeminiPlanFileCandidate = {
  readonly path: string;
  readonly mtimeMs: number;
};

async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function geminiPlanDirectorySetting(
  settings: Record<string, unknown> | undefined,
): string | undefined {
  const general = asObject(settings?.general);
  const plan = asObject(general?.plan);
  const directory = asString(plan?.directory);
  return directory && directory.length > 0 ? directory : undefined;
}

function resolveGeminiPlanDirectory(cwd: string, directory: string): string {
  return path.isAbsolute(directory) ? directory : path.resolve(cwd, directory);
}

async function configuredGeminiPlanDirectories(input: {
  readonly cwd: string;
  readonly homeDir: string;
}): Promise<ReadonlyArray<string>> {
  const settingsPaths = [
    path.join(input.homeDir, ".gemini", "settings.json"),
    path.join(input.cwd, ".gemini", "settings.json"),
  ];
  const directories: Array<string> = [];
  for (const settingsPath of settingsPaths) {
    const settings = await readJsonObjectFile(settingsPath);
    const directory = geminiPlanDirectorySetting(settings);
    if (directory) {
      directories.push(resolveGeminiPlanDirectory(input.cwd, directory));
    }
  }
  return Array.from(new Set(directories));
}

async function collectMarkdownPlanFiles(input: {
  readonly directory: string;
  readonly changedAfterMs?: number | undefined;
  readonly maxDepth: number;
}): Promise<ReadonlyArray<GeminiPlanFileCandidate>> {
  let entries;
  try {
    entries = await readdir(input.directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<GeminiPlanFileCandidate> = [];
  for (const entry of entries) {
    const entryPath = path.join(input.directory, entry.name);
    if (entry.isDirectory()) {
      if (input.maxDepth > 0) {
        candidates.push(
          ...(await collectMarkdownPlanFiles({
            directory: entryPath,
            changedAfterMs: input.changedAfterMs,
            maxDepth: input.maxDepth - 1,
          })),
        );
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    try {
      const fileStat = await stat(entryPath);
      if (fileStat.size <= 0 || fileStat.size > GEMINI_PLAN_FILE_MAX_BYTES) {
        continue;
      }
      if (
        input.changedAfterMs !== undefined &&
        fileStat.mtimeMs < input.changedAfterMs - GEMINI_PLAN_FILE_MTIME_MARGIN_MS
      ) {
        continue;
      }
      candidates.push({ path: entryPath, mtimeMs: fileStat.mtimeMs });
    } catch {
      // Ignore files that disappear while Gemini is updating the plan.
    }
  }
  return candidates;
}

async function findGeminiDefaultSessionPlanDirectories(input: {
  readonly homeDir: string;
  readonly sessionId: string;
}): Promise<ReadonlyArray<string>> {
  const root = path.join(input.homeDir, ".gemini", "tmp");
  const directories: Array<string> = [];

  const visit = async (directory: string, remainingDepth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.name === input.sessionId) {
        directories.push(path.join(entryPath, "plans"));
        continue;
      }
      if (remainingDepth > 0) {
        await visit(entryPath, remainingDepth - 1);
      }
    }
  };

  await visit(root, 4);
  return directories;
}

export async function readLatestGeminiPlanMarkdown(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly homeDir?: string;
  readonly changedAfterMs?: number | undefined;
}): Promise<string | undefined> {
  const homeDir = input.homeDir ?? process.env.HOME ?? homedir();
  const directories = Array.from(
    new Set([
      ...(await configuredGeminiPlanDirectories({ cwd: input.cwd, homeDir })),
      ...(await findGeminiDefaultSessionPlanDirectories({
        homeDir,
        sessionId: input.sessionId,
      })),
    ]),
  );

  const candidates = (
    await Promise.all(
      directories.map((directory) =>
        collectMarkdownPlanFiles({
          directory,
          changedAfterMs: input.changedAfterMs,
          maxDepth: 2,
        }),
      ),
    )
  )
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates) {
    try {
      const content = (await readFile(candidate.path, "utf8")).trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // Keep looking if Gemini rotates the candidate before we read it.
    }
  }
  return undefined;
}

function extractTextContent(value: unknown): string | undefined {
  const record = asObject(value);
  if (asString(record?.text)) {
    return asString(record?.text);
  }
  return undefined;
}

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function extractToolDetail(
  content: ReadonlyArray<GeminiToolCallContent> | null | undefined,
): string | undefined {
  for (const entry of content ?? []) {
    if (entry.type === "content") {
      const text = extractTextContent(entry.content);
      if (text) {
        return text;
      }
      continue;
    }
    if (entry.type === "diff") {
      return entry.path;
    }
    if (entry.type === "terminal") {
      return entry.terminalId;
    }
  }
  return undefined;
}

function extractGeminiToolCommand(toolCall: GeminiToolCallLike): string | undefined {
  const rawInput = asObject(toolCall.rawInput);
  return (
    asString(rawInput?.command) ??
    asString(rawInput?.cmd) ??
    asString(rawInput?.shellCommand) ??
    (toolCall.kind === "execute" ? asString(rawInput?.text) : undefined)
  );
}

function extractGeminiToolCwd(toolCall: GeminiToolCallLike): string | undefined {
  const rawInput = asObject(toolCall.rawInput);
  const rawOutput = asObject(toolCall.rawOutput);
  return (
    asString(rawInput?.cwd) ??
    asString(rawInput?.workingDirectory) ??
    asString(rawOutput?.cwd) ??
    asString(rawOutput?.workingDirectory)
  );
}

function extractGeminiToolOutput(toolCall: GeminiToolCallLike): string | undefined {
  if (typeof toolCall.rawOutput === "string" && toolCall.rawOutput.length > 0) {
    return toolCall.rawOutput;
  }
  const rawOutput = asObject(toolCall.rawOutput);
  const direct =
    asString(rawOutput?.output) ??
    asString(rawOutput?.aggregatedOutput) ??
    asString(rawOutput?.stdout) ??
    asString(rawOutput?.stderr) ??
    asString(rawOutput?.content) ??
    asString(rawOutput?.text);
  if (direct) {
    return direct;
  }
  return toolCall.status === "completed" || toolCall.status === "failed"
    ? extractToolDetail(toolCall.content)
    : undefined;
}

function buildGeminiToolData(toolCall: GeminiToolCallLike): Record<string, unknown> {
  const command = extractGeminiToolCommand(toolCall);
  const cwd = extractGeminiToolCwd(toolCall);
  const output = extractGeminiToolOutput(toolCall);
  const subagent = geminiSubagentMetadata(toolCall);
  return {
    toolCallId: toolCall.toolCallId,
    ...(toolCall.kind ? { kind: toolCall.kind } : {}),
    ...(toolCall.rawInput !== undefined
      ? { input: toolCall.rawInput, rawInput: toolCall.rawInput }
      : {}),
    ...(toolCall.rawOutput !== undefined
      ? { result: toolCall.rawOutput, rawOutput: toolCall.rawOutput }
      : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(output ? { output, aggregatedOutput: output } : {}),
    ...(subagent
      ? {
          subagent,
          subagentId: subagent.id,
          ...(subagent.type ? { agentRole: subagent.type, subagentType: subagent.type } : {}),
          ...(subagent.name
            ? {
                agentDisplayName: subagent.name,
                agentName: subagent.name,
                subagentName: subagent.name,
              }
            : {}),
          ...(subagent.model ? { model: subagent.model } : {}),
        }
      : {}),
    ...(toolCall.content ? { content: toolCall.content } : {}),
    ...(toolCall.locations ? { locations: toolCall.locations } : {}),
    item: {
      id: toolCall.toolCallId,
      toolCallId: toolCall.toolCallId,
      ...(toolCall.kind ? { kind: toolCall.kind } : {}),
      ...(asString(toolCall.title) ? { title: asString(toolCall.title) } : {}),
      ...(toolCall.status ? { status: toolCall.status } : {}),
      ...(toolCall.rawInput !== undefined
        ? { input: toolCall.rawInput, rawInput: toolCall.rawInput }
        : {}),
      ...(toolCall.rawOutput !== undefined
        ? { result: toolCall.rawOutput, rawOutput: toolCall.rawOutput }
        : {}),
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(output ? { output, aggregatedOutput: output } : {}),
      ...(subagent
        ? {
            subagent,
            subagentId: subagent.id,
            ...(subagent.type ? { agentRole: subagent.type, subagentType: subagent.type } : {}),
            ...(subagent.name
              ? {
                  agentDisplayName: subagent.name,
                  agentName: subagent.name,
                  subagentName: subagent.name,
                }
              : {}),
            ...(subagent.model ? { model: subagent.model } : {}),
          }
        : {}),
    },
  };
}

export function buildGeminiPromptText(input: ProviderSendTurnInput): string {
  const text = input.input ?? "";
  if (input.interactionMode !== "plan") {
    return text;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "/plan";
  }
  if (/^\/plan(?:\s|$)/iu.test(trimmed)) {
    return trimmed;
  }
  return `/plan ${trimmed}`;
}

function buildPromptContent(
  input: ProviderSendTurnInput,
  attachmentsDir: string,
): ReadonlyArray<GeminiPromptContent> {
  const content: GeminiPromptContent[] = [];
  const promptText = buildGeminiPromptText(input);

  if (promptText.trim().length > 0) {
    content.push({
      type: "text",
      text: promptText,
    });
  }

  for (const attachment of input.attachments ?? []) {
    const resolvedPath = resolveAttachmentPath({
      attachmentsDir,
      attachment,
    });
    if (!resolvedPath) {
      continue;
    }
    content.push({
      type: "resource_link",
      uri: pathToFileURL(resolvedPath).href,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.sizeBytes,
    });
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: " ",
    });
  }

  return content;
}

function selectPermissionOption(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly name: string;
    readonly kind: GeminiPermissionOptionKind;
  }>,
  decision: ProviderApprovalDecision,
):
  | {
      readonly optionId: string;
      readonly kind: GeminiPermissionOptionKind;
    }
  | undefined {
  const firstOfKind = (kind: GeminiPermissionOptionKind) =>
    options.find((option) => option.kind === kind);

  switch (decision) {
    case "acceptForSession":
      return firstOfKind("allow_always") ?? firstOfKind("allow_once") ?? firstOfKind("reject_once");
    case "accept":
      return firstOfKind("allow_once") ?? firstOfKind("allow_always") ?? firstOfKind("reject_once");
    case "decline":
      return firstOfKind("reject_once") ?? firstOfKind("reject_always");
    case "cancel":
    default:
      return undefined;
  }
}

function isGeminiUserInputRequestMethod(method: string): boolean {
  return (
    method === "session/request_user_input" ||
    method === "session/requestUserInput" ||
    method === "session/request_input" ||
    method === "session/ask_user" ||
    method === "session/askUser" ||
    method === "session/elicitation" ||
    method === "elicitation/request"
  );
}

function geminiUserInputOption(value: unknown): UserInputQuestion["options"][number] | null {
  if (typeof value === "string") {
    const label = value.trim();
    return label ? { label, description: "" } : null;
  }
  const record = asObject(value);
  if (!record) {
    return null;
  }
  const label =
    asString(record.label) ??
    asString(record.name) ??
    asString(record.title) ??
    asString(record.value) ??
    asString(record.id);
  if (!label) {
    return null;
  }
  return {
    label,
    description: asString(record.description) ?? asString(record.detail) ?? "",
  };
}

function geminiUserInputOptions(value: unknown): UserInputQuestion["options"] {
  return asArray(value)
    .map(geminiUserInputOption)
    .filter((option) => option !== null);
}

function geminiUserInputQuestion(value: unknown, fallbackIndex: number): UserInputQuestion | null {
  const record = asObject(value);
  if (!record) {
    if (typeof value === "string" && value.trim().length > 0) {
      return {
        id: `question-${fallbackIndex + 1}`,
        header: "Gemini question",
        question: value.trim(),
        options: [],
      };
    }
    return null;
  }

  const id =
    asString(record.id) ??
    asString(record.questionId) ??
    asString(record.question_id) ??
    asString(record.name) ??
    `question-${fallbackIndex + 1}`;
  const header =
    asString(record.header) ?? asString(record.title) ?? asString(record.name) ?? "Gemini question";
  const question =
    asString(record.question) ??
    asString(record.prompt) ??
    asString(record.message) ??
    asString(record.text) ??
    asString(record.description) ??
    header;
  const options = geminiUserInputOptions(record.options ?? record.choices ?? record.items);
  return {
    id,
    header,
    question,
    options,
    ...(typeof record.multiSelect === "boolean"
      ? { multiSelect: record.multiSelect }
      : typeof record.multi_select === "boolean"
        ? { multiSelect: record.multi_select }
        : {}),
  };
}

function geminiUserInputQuestions(
  params: Record<string, unknown>,
): ReadonlyArray<UserInputQuestion> {
  const questionList = asArray(params.questions ?? params.prompts ?? params.fields)
    .map(geminiUserInputQuestion)
    .filter((question) => question !== null);
  if (questionList.length > 0) {
    return questionList;
  }

  const single = geminiUserInputQuestion(params, 0);
  return single ? [single] : [];
}

function firstGeminiUserInputAnswer(answers: ProviderUserInputAnswers): unknown {
  for (const value of Object.values(answers)) {
    if (Array.isArray(value)) {
      return value[0] ?? "";
    }
    return value;
  }
  return "";
}

const makeGeminiAdapter = Effect.gen(function* () {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const sessions = new Map<ThreadId, GeminiSessionContext>();

  const emit = (event: ProviderRuntimeEvent): void => {
    runLoggedEffect({
      runPromise,
      effect: Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      message: "Failed to emit Gemini runtime event.",
      metadata: { eventId: event.eventId, threadId: event.threadId, type: event.type },
    });
  };

  const reportClientCloseFailure = (cause: unknown, metadata?: Record<string, unknown>) => {
    logWarningEffect({
      runPromise,
      message: "Failed to close Gemini ACP client.",
      metadata: {
        ...metadata,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    });
  };

  const closeGeminiProviderSession = async (
    context: GeminiSessionContext,
    phase: string,
  ): Promise<void> => {
    if (!context.metadata.closeSession) {
      return;
    }
    const sessionId = readGeminiResumeCursor(context.session.resumeCursor);
    if (!sessionId) {
      return;
    }
    try {
      await context.client.request(
        "session/close",
        { sessionId },
        { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
      );
    } catch (cause) {
      logWarningEffect({
        runPromise,
        message: "Gemini native session close failed; closing client anyway.",
        metadata: {
          phase,
          threadId: context.session.threadId,
          sessionId,
          cause: meaningfulErrorMessage(cause, "Unknown Gemini session close failure"),
        },
      });
    }
  };

  const baseEvent = <TType extends ProviderRuntimeEvent["type"]>(
    context: GeminiSessionContext,
    input: {
      readonly type: TType;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
      readonly createdAt?: string;
      readonly turnId?: TurnId;
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
    },
  ): ProviderRuntimeEventByType<TType> => {
    const createdAt = input.createdAt ?? isoNow();
    const timestampMs = parseIsoTimestampMs(createdAt);
    const sessionSequence = (() => {
      if (timestampMs !== undefined) {
        const nextTieBreaker = (context.sequenceTieBreakersByTimestampMs.get(timestampMs) ?? 0) + 1;
        context.sequenceTieBreakersByTimestampMs.set(timestampMs, nextTieBreaker);
        return timestampMs * 1_000 + nextTieBreaker;
      }
      context.nextFallbackSessionSequence += 1;
      return context.nextFallbackSessionSequence;
    })();

    return {
      type: input.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      sessionSequence,
      payload: input.payload,
    } as unknown as ProviderRuntimeEventByType<TType>;
  };

  const emitProposedPlanCompleted = (
    context: GeminiSessionContext,
    turn: GeminiTurnState,
    input: {
      readonly planMarkdown: string;
      readonly createdAt?: string;
    },
  ): void => {
    const planMarkdown = input.planMarkdown.trim();
    if (planMarkdown.length === 0 || turn.lastProposedPlanMarkdown === planMarkdown) {
      return;
    }

    turn.lastProposedPlanMarkdown = planMarkdown;
    emit(
      baseEvent(context, {
        type: "turn.proposed.completed",
        turnId: turn.id,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        payload: {
          planMarkdown,
        },
      }),
    );
  };

  const refreshProposedPlanFromGeminiFiles = async (
    context: GeminiSessionContext,
    turn: GeminiTurnState,
  ): Promise<void> => {
    if (!context.session.cwd) {
      return;
    }
    try {
      const planMarkdown = await readLatestGeminiPlanMarkdown({
        cwd: context.session.cwd,
        sessionId: context.sessionId,
        changedAfterMs: turn.startedAtMs,
      });
      if (!planMarkdown || context.closed || context.activeTurn?.id !== turn.id) {
        return;
      }
      emitProposedPlanCompleted(context, turn, { planMarkdown });
    } catch (cause) {
      if (context.closed || context.activeTurn?.id !== turn.id) {
        return;
      }
      emit(
        baseEvent(context, {
          type: "runtime.warning",
          turnId: turn.id,
          payload: {
            message: toMessage(cause, "Failed to read Gemini plan."),
          },
        }),
      );
    }
  };

  const createToolItemState = (
    context: GeminiSessionContext,
    toolCall: GeminiToolCallLike,
    createdAt?: string,
  ): GeminiToolItemState | null => {
    const turn = context.activeTurn;
    if (!turn) {
      return null;
    }
    const existing = turn.toolItems.get(toolCall.toolCallId);
    if (existing) {
      const nextItemType = runtimeItemTypeFromToolCall(toolCall);
      if (existing.itemType === "dynamic_tool_call" && nextItemType === "collab_agent_tool_call") {
        existing.itemType = nextItemType;
      }
      return existing;
    }

    const item = {
      itemId: RuntimeItemId.makeUnsafe(`gemini-tool:${toolCall.toolCallId}`),
      itemType: runtimeItemTypeFromToolCall(toolCall),
      completed: false,
    } satisfies GeminiToolItemState;

    turn.toolItems.set(toolCall.toolCallId, item);
    emit(
      baseEvent(context, {
        type: "item.started",
        ...(createdAt ? { createdAt } : {}),
        turnId: turn.id,
        itemId: item.itemId,
        payload: {
          itemType: item.itemType,
          status: "inProgress",
          ...(asString(toolCall.title) ? { title: asString(toolCall.title) } : {}),
          ...(extractToolDetail(toolCall.content)
            ? { detail: extractToolDetail(toolCall.content) }
            : {}),
          data: buildGeminiToolData(toolCall),
        },
      }),
    );

    return item;
  };

  const updateToolItem = (
    context: GeminiSessionContext,
    toolCall: GeminiToolCallLike,
    createdAt?: string,
  ) => {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }
    const item = createToolItemState(context, toolCall, createdAt);
    if (!item) {
      return;
    }
    const turnId = turn.id;
    const payload = {
      itemType: item.itemType,
      ...(asString(toolCall.title) ? { title: asString(toolCall.title) } : {}),
      ...(extractToolDetail(toolCall.content)
        ? { detail: extractToolDetail(toolCall.content) }
        : {}),
      data: buildGeminiToolData(toolCall),
    } as const;

    if (toolCall.status === "completed" || toolCall.status === "failed") {
      item.completed = true;
      emit(
        baseEvent(context, {
          type: "item.completed",
          ...(createdAt ? { createdAt } : {}),
          turnId,
          itemId: item.itemId,
          payload: {
            ...payload,
            status: toolCall.status === "failed" ? "failed" : "completed",
          },
        }),
      );
      return;
    }

    emit(
      baseEvent(context, {
        type: "item.updated",
        ...(createdAt ? { createdAt } : {}),
        turnId,
        itemId: item.itemId,
        payload: {
          ...payload,
          status: "inProgress",
        },
      }),
    );
  };

  const ensureAssistantStarted = (context: GeminiSessionContext, createdAt?: string) => {
    const turn = context.activeTurn;
    if (!turn || turn.assistantStarted) {
      return;
    }
    turn.assistantStarted = true;
    emit(
      baseEvent(context, {
        type: "item.started",
        ...(createdAt ? { createdAt } : {}),
        turnId: turn.id,
        itemId: turn.assistantItemId,
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
        },
      }),
    );
  };

  const ensureReasoningStarted = (context: GeminiSessionContext, createdAt?: string) => {
    const turn = context.activeTurn;
    if (!turn || turn.reasoningStarted) {
      return;
    }
    turn.reasoningStarted = true;
    emit(
      baseEvent(context, {
        type: "item.started",
        ...(createdAt ? { createdAt } : {}),
        turnId: turn.id,
        itemId: turn.reasoningItemId,
        payload: {
          itemType: "reasoning",
          status: "inProgress",
        },
      }),
    );
  };

  const completePendingToolItems = (
    context: GeminiSessionContext,
    turn: GeminiTurnState,
    state: GeminiOutcome["state"],
  ) => {
    for (const item of turn.toolItems.values()) {
      if (item.completed) {
        continue;
      }
      item.completed = true;
      emit(
        baseEvent(context, {
          type: "item.completed",
          turnId: turn.id,
          itemId: item.itemId,
          payload: {
            itemType: item.itemType,
            status:
              state === "failed" ? "failed" : state === "interrupted" ? "declined" : "completed",
          },
        }),
      );
    }
  };

  const completeTurn = (context: GeminiSessionContext, outcome: GeminiOutcome) => {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }

    if (turn.started) {
      completePendingToolItems(context, turn, outcome.state);
      if (turn.reasoningStarted) {
        emit(
          baseEvent(context, {
            type: "item.completed",
            turnId: turn.id,
            itemId: turn.reasoningItemId,
            payload: {
              itemType: "reasoning",
              status: outcome.state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }
      if (turn.assistantStarted) {
        emit(
          baseEvent(context, {
            type: "item.completed",
            turnId: turn.id,
            itemId: turn.assistantItemId,
            payload: {
              itemType: "assistant_message",
              status: outcome.state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }

      const usageSnapshot = buildGeminiTurnUsageSnapshot(
        outcome.usage,
        turn,
        context.lastUsageSnapshot,
      );
      const processedTokens = readGeminiProcessedTokens(outcome.usage);
      if (processedTokens !== undefined && processedTokens > 0) {
        context.totalProcessedTokens += processedTokens;
      }
      const completedUsageSnapshot =
        usageSnapshot !== undefined
          ? {
              ...usageSnapshot,
              ...(context.totalProcessedTokens > usageSnapshot.usedTokens
                ? { totalProcessedTokens: context.totalProcessedTokens }
                : {}),
            }
          : undefined;
      if (completedUsageSnapshot) {
        context.lastUsageSnapshot = {
          usedTokens: completedUsageSnapshot.usedTokens,
          ...(completedUsageSnapshot.maxTokens !== undefined
            ? { maxTokens: completedUsageSnapshot.maxTokens }
            : {}),
          ...(context.totalProcessedTokens > 0
            ? { totalProcessedTokens: context.totalProcessedTokens }
            : {}),
        };
        emit(
          baseEvent(context, {
            type: "thread.token-usage.updated",
            turnId: turn.id,
            payload: {
              usage: completedUsageSnapshot,
            },
          }),
        );
      }
    }

    cancelPendingPermissionsForTurn(context, turn.id);
    cancelPendingUserInputsForTurn(context, turn.id);
    if (turn.started) {
      context.turns.push({ id: turn.id, items: [...turn.items] });
      context.replayTurns.push({
        prompt: turn.inputText,
        attachmentNames: [...turn.attachmentNames],
        ...(turn.assistantText.trim().length > 0 ? { assistantResponse: turn.assistantText } : {}),
      });
    }
    context.activeTurn = null;
    context.session = {
      ...context.session,
      status: outcome.state === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      updatedAt: isoNow(),
      ...(outcome.state === "failed"
        ? { lastError: outcome.errorMessage }
        : { lastError: undefined }),
    };

    if (!turn.started) {
      return;
    }

    emit(
      baseEvent(context, {
        type: "turn.completed",
        turnId: turn.id,
        payload: {
          state: outcome.state,
          ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
          ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
          ...(outcome.state === "failed" ? { errorMessage: outcome.errorMessage } : {}),
        },
      }),
    );
  };

  const resolvePendingPermission = (
    context: GeminiSessionContext,
    pending: GeminiPendingPermission,
    input:
      | {
          readonly decision: "cancel";
        }
      | {
          readonly decision: Exclude<ProviderApprovalDecision, "cancel">;
          readonly optionId: string;
          readonly kind: GeminiPermissionOptionKind;
        },
  ) => {
    context.pendingPermissions.delete(pending.requestId);
    if (context.activeTurn && input.decision === "cancel") {
      const toolItem = context.activeTurn.toolItems.get(pending.toolCallId);
      if (toolItem && !toolItem.completed) {
        toolItem.completed = true;
        emit(
          baseEvent(context, {
            type: "item.completed",
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            itemId: toolItem.itemId,
            payload: {
              itemType: toolItem.itemType,
              status: "declined",
            },
          }),
        );
      }
    }
    emit(
      baseEvent(context, {
        type: "request.resolved",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: pending.requestId,
        payload: {
          requestType: pending.requestType,
          decision: input.decision,
          ...(input.decision === "cancel"
            ? {
                resolution: {
                  outcome: "cancelled",
                },
              }
            : {
                resolution: {
                  optionId: input.optionId,
                  kind: input.kind,
                },
              }),
        },
      }),
    );
  };

  const cancelPendingPermissionsForTurn = (context: GeminiSessionContext, turnId: TurnId) => {
    for (const pending of context.pendingPermissions.values()) {
      if (pending.turnId !== turnId) {
        continue;
      }
      context.client.respond(pending.jsonRpcId, {
        outcome: {
          outcome: "cancelled",
        },
      });
      resolvePendingPermission(context, pending, {
        decision: "cancel",
      });
    }
  };

  const emitGeminiUserInputResolved = (
    context: GeminiSessionContext,
    pending: GeminiPendingUserInput,
    answers: ProviderUserInputAnswers,
  ) => {
    emit(
      baseEvent(context, {
        type: "user-input.resolved",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: pending.requestId,
        payload: { answers },
      }),
    );
  };

  const cancelPendingUserInputsForTurn = (context: GeminiSessionContext, turnId: TurnId) => {
    for (const pending of context.pendingUserInputs.values()) {
      if (pending.turnId !== turnId) {
        continue;
      }
      context.client.respond(pending.jsonRpcId, {
        answers: {},
        answer: "",
        response: "",
        cancelled: true,
      });
      context.pendingUserInputs.delete(pending.requestId);
      emitGeminiUserInputResolved(context, pending, {});
    }
  };

  const handleGeminiUserInputRequest = (
    context: GeminiSessionContext,
    request: AcpRequest,
  ): void => {
    const params = asObject(request.params);
    if (!params) {
      context.client.respondError(request.id, -32602, "Invalid Gemini user-input request.");
      return;
    }
    const requestSessionId = asString(params.sessionId);
    if (requestSessionId && requestSessionId !== context.sessionId) {
      context.client.respondError(request.id, -32000, "Session not found.");
      return;
    }
    const questions = geminiUserInputQuestions(params);
    if (questions.length === 0) {
      context.client.respondError(request.id, -32602, "Gemini user-input request has no question.");
      return;
    }

    const requestId = RuntimeRequestId.makeUnsafe(String(request.id));
    const pending: GeminiPendingUserInput = {
      jsonRpcId: request.id,
      requestId,
      ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
      questions,
    };
    context.pendingUserInputs.set(requestId, pending);
    emit(
      baseEvent(context, {
        type: "user-input.requested",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId,
        payload: { questions },
      }),
    );
  };

  const handleGeminiPermissionRequest = async (
    context: GeminiSessionContext,
    request: AcpRequest,
  ): Promise<void> => {
    const params = asObject(request.params);
    if (!params) {
      context.client.respondError(request.id, -32602, "Invalid Gemini permission request.");
      return;
    }
    const requestSessionId = asString(params.sessionId);
    if (requestSessionId !== context.sessionId) {
      context.client.respondError(request.id, -32000, "Session not found.");
      return;
    }
    const toolCall = asObject(params.toolCall);
    const toolCallId = asString(toolCall?.toolCallId);
    if (!toolCallId) {
      context.client.respondError(
        request.id,
        -32602,
        "Gemini permission request is missing toolCallId.",
      );
      return;
    }

    const pendingOptions = asArray(params.options)
      .map((entry) => {
        const option = asObject(entry);
        const optionId = asString(option?.optionId);
        const name = asString(option?.name);
        const kind = asString(option?.kind) as GeminiPermissionOptionKind | undefined;
        if (!optionId || !name || !kind) {
          return null;
        }
        return { optionId, name, kind };
      })
      .filter(
        (
          entry,
        ): entry is {
          readonly optionId: string;
          readonly name: string;
          readonly kind: GeminiPermissionOptionKind;
        } => entry !== null,
      );

    const status = asString(toolCall?.status);
    const title = asString(toolCall?.title);
    const kind = asString(toolCall?.kind);
    const normalizedToolCall: GeminiToolCallLike = {
      toolCallId,
      ...(status ? { status: status as GeminiToolStatus } : {}),
      ...(title ? { title } : {}),
      ...(kind ? { kind: kind as GeminiToolKind } : {}),
      ...(Array.isArray(toolCall?.content)
        ? { content: toolCall?.content as ReadonlyArray<GeminiToolCallContent> }
        : {}),
      ...(Array.isArray(toolCall?.locations)
        ? { locations: toolCall?.locations as ReadonlyArray<GeminiToolLocation> }
        : {}),
      ...("rawInput" in (toolCall ?? {}) ? { rawInput: toolCall?.rawInput } : {}),
      ...("rawOutput" in (toolCall ?? {}) ? { rawOutput: toolCall?.rawOutput } : {}),
    };

    createToolItemState(context, normalizedToolCall);

    const requestId = RuntimeRequestId.makeUnsafe(String(request.id));
    if (shouldAutoResolveGeminiPermission(context.session.runtimeMode)) {
      const selectedOption = selectPermissionOption(pendingOptions, "acceptForSession");
      if (selectedOption) {
        context.client.respond(request.id, {
          outcome: {
            outcome: "selected",
            optionId: selectedOption.optionId,
          },
        });
        emit(
          baseEvent(context, {
            type: "request.resolved",
            ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
            payload: {
              requestType: requestTypeFromToolKind(normalizedToolCall.kind),
              decision: "acceptForSession",
              resolution: {
                optionId: selectedOption.optionId,
                kind: selectedOption.kind,
              },
            },
          }),
        );
        return;
      }
    }

    const pending: GeminiPendingPermission = {
      jsonRpcId: request.id,
      requestId,
      ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
      requestType: requestTypeFromToolKind(normalizedToolCall.kind),
      options: pendingOptions,
      toolCallId,
    };
    context.pendingPermissions.set(requestId, pending);

    emit(
      baseEvent(context, {
        type: "request.opened",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId,
        payload: {
          requestType: pending.requestType,
          ...(asString(normalizedToolCall.title)
            ? { detail: asString(normalizedToolCall.title) }
            : {}),
          args: params,
        },
      }),
    );
  };

  const handleGeminiNotification = (
    context: GeminiSessionContext,
    notification: AcpNotification,
  ) => {
    if (notification.method !== "session/update") {
      return;
    }
    const params = asObject(notification.params);
    if (!params || asString(params.sessionId) !== context.sessionId) {
      return;
    }
    const update = asObject(params.update);
    if (!update) {
      return;
    }

    const updateType = asString(update.sessionUpdate);
    if (!updateType) {
      return;
    }
    const notificationCreatedAt = resolveGeminiNotificationCreatedAt(params, update);

    switch (updateType) {
      case "agent_message_chunk": {
        const delta = extractTextContent(update.content);
        if (!delta || !context.activeTurn) {
          return;
        }
        ensureAssistantStarted(context, notificationCreatedAt);
        context.activeTurn.assistantText += delta;
        emit(
          baseEvent(context, {
            type: "content.delta",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            turnId: context.activeTurn.id,
            itemId: context.activeTurn.assistantItemId,
            payload: {
              streamKind: "assistant_text",
              delta,
            },
          }),
        );
        return;
      }
      case "agent_thought_chunk": {
        const delta = extractTextContent(update.content);
        if (!delta || !context.activeTurn) {
          return;
        }
        ensureReasoningStarted(context, notificationCreatedAt);
        emit(
          baseEvent(context, {
            type: "content.delta",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            turnId: context.activeTurn.id,
            itemId: context.activeTurn.reasoningItemId,
            payload: {
              streamKind: "reasoning_text",
              delta,
            },
          }),
        );
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (!context.activeTurn) {
          return;
        }
        const toolCallId = asString(update.toolCallId);
        const status = asString(update.status);
        const title = asString(update.title);
        const kind = asString(update.kind);
        if (!toolCallId) {
          return;
        }
        updateToolItem(
          context,
          {
            toolCallId,
            ...(status ? { status: status as GeminiToolStatus } : {}),
            ...(title ? { title } : {}),
            ...(kind ? { kind: kind as GeminiToolKind } : {}),
            ...(Array.isArray(update.content)
              ? { content: update.content as ReadonlyArray<GeminiToolCallContent> }
              : {}),
            ...(Array.isArray(update.locations)
              ? { locations: update.locations as ReadonlyArray<GeminiToolLocation> }
              : {}),
            ...("rawInput" in update ? { rawInput: update.rawInput } : {}),
            ...("rawOutput" in update ? { rawOutput: update.rawOutput } : {}),
          },
          notificationCreatedAt,
        );
        return;
      }
      case "plan": {
        if (!context.activeTurn) {
          return;
        }
        const entries = asArray(update.entries)
          .map((entry) => {
            const planEntry = asObject(entry);
            const content = asString(planEntry?.content);
            if (!content) {
              return null;
            }
            return {
              step: content,
              status: mapPlanStatus(asString(planEntry?.status)),
            };
          })
          .filter(
            (
              entry,
            ): entry is {
              readonly step: string;
              readonly status: "pending" | "inProgress" | "completed";
            } => entry !== null,
          );
        emit(
          baseEvent(context, {
            type: "turn.plan.updated",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            turnId: context.activeTurn.id,
            payload: {
              plan: entries,
            },
          }),
        );
        return;
      }
      case "usage_update": {
        const usage = buildGeminiContextUsageSnapshot(update, context.activeTurn);
        if (!usage) {
          return;
        }
        const liveUsageSnapshot = {
          ...usage,
          ...(context.totalProcessedTokens > usage.usedTokens
            ? { totalProcessedTokens: context.totalProcessedTokens }
            : {}),
        };
        context.lastUsageSnapshot = {
          usedTokens: usage.usedTokens,
          ...(usage.maxTokens !== undefined ? { maxTokens: usage.maxTokens } : {}),
          ...(context.totalProcessedTokens > 0
            ? { totalProcessedTokens: context.totalProcessedTokens }
            : {}),
        };
        emit(
          baseEvent(context, {
            type: "thread.token-usage.updated",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
            payload: {
              usage: liveUsageSnapshot,
            },
          }),
        );
        return;
      }
      case "session_info_update": {
        const title = asString(update.title);
        const updatedAt = asString(update.updatedAt);
        if (!title && !updatedAt) {
          return;
        }
        emit(
          baseEvent(context, {
            type: "thread.metadata.updated",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            payload: {
              ...(title ? { name: title } : {}),
              metadata: updatedAt ? { updatedAt } : {},
            },
          }),
        );
        return;
      }
      case "current_mode_update": {
        const currentModeId = asString(update.currentModeId);
        if (!currentModeId) {
          return;
        }
        context.metadata = {
          ...context.metadata,
          currentModeId,
        };
        emit(
          baseEvent(context, {
            type: "session.configured",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            payload: {
              config: {
                ...geminiSessionConfigSnapshot(context.metadata),
                currentModeId,
              },
            },
          }),
        );
        return;
      }
      case "available_commands_update": {
        context.metadata = {
          ...context.metadata,
          availableCommands: normalizeAvailableCommands(update.availableCommands),
        };
        emit(
          baseEvent(context, {
            type: "session.configured",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            payload: {
              config: geminiSessionConfigSnapshot(context.metadata),
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  };

  const syncGeminiSessionState = async (
    context: GeminiSessionContext,
    input: {
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly interactionMode: ProviderSendTurnInput["interactionMode"];
      readonly modelSelection?:
        | ProviderSessionStartInput["modelSelection"]
        | ProviderSendTurnInput["modelSelection"];
    },
  ): Promise<void> => {
    const explicitModeId = explicitGeminiModeId(input.modelSelection);
    const desiredModeId =
      explicitModeId ??
      resolveDesiredModeId(context.metadata, input.runtimeMode, input.interactionMode);
    const canSetMode = canGeminiSetSessionMode(context.metadata);
    const planModePinnedAtLaunch =
      !explicitModeId &&
      input.interactionMode === "plan" &&
      !desiredModeId &&
      context.launchApprovalModeApplied === "plan";
    if (!explicitModeId && input.interactionMode === "plan" && !desiredModeId) {
      if (!planModePinnedAtLaunch) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/set_mode",
          detail:
            "Gemini ACP session does not expose a plan mode and the process was not launched with --approval-mode=plan.",
        });
      }
    }
    if (
      explicitModeId &&
      !context.metadata.availableModes.some((mode) => mode.id === explicitModeId)
    ) {
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/set_mode",
        detail: `Gemini ACP session does not support mode '${explicitModeId}'.`,
      });
    }
    if (
      !planModePinnedAtLaunch &&
      canSetMode &&
      desiredModeId &&
      context.metadata.currentModeId !== desiredModeId
    ) {
      await context.client.request(
        "session/set_mode",
        {
          sessionId: context.sessionId,
          modeId: desiredModeId,
        },
        { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
      );
      context.metadata = {
        ...context.metadata,
        currentModeId: desiredModeId,
      };
      emit(
        baseEvent(context, {
          type: "session.configured",
          payload: {
            config: {
              ...geminiSessionConfigSnapshot(context.metadata),
              currentModeId: desiredModeId,
            },
          },
        }),
      );
    }

    const desiredModel =
      input.modelSelection?.provider === PROVIDER
        ? input.modelSelection.model
        : (context.session.model ?? DEFAULT_MODEL_BY_PROVIDER.gemini);
    const canSetModel = canGeminiSetSessionModel(context.metadata);
    if (canSetModel && context.metadata.currentModelId !== desiredModel) {
      await context.client.request(
        "session/set_model",
        {
          sessionId: context.sessionId,
          modelId: desiredModel,
        },
        { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
      );
      context.metadata = {
        ...context.metadata,
        currentModelId: desiredModel,
      };
      context.session = {
        ...context.session,
        model: desiredModel,
        updatedAt: isoNow(),
      };
      emit(
        baseEvent(context, {
          type: "session.configured",
          payload: {
            config: {
              ...geminiSessionConfigSnapshot(context.metadata),
              currentModelId: desiredModel,
            },
          },
        }),
      );
    }
  };

  const startInitializedGeminiClient = async (
    binaryPath: string,
    cwd: string,
    approvalMode: GeminiLaunchApprovalMode,
    env: NodeJS.ProcessEnv = {},
  ): Promise<{
    readonly client: AcpClient;
    readonly metadata: GeminiSessionMetadata;
    readonly launchApprovalModeApplied?: GeminiLaunchApprovalMode;
  }> => {
    const initializeParams = buildGeminiInitializeParams();

    const attempts = buildGeminiAcpArgAttempts(approvalMode);
    let lastError: unknown = undefined;
    for (const args of attempts) {
      const client = startAcpClient({
        binaryPath,
        args,
        cwd,
        env: {
          ...env,
          NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? "1",
        },
      });
      try {
        const initializeResult = await client.request("initialize", initializeParams, {
          timeoutMs: ACP_CONTROL_TIMEOUT_MS,
        });
        return {
          client,
          metadata: normalizeInitializeResponse(initializeResult),
          ...(args.includes(`--approval-mode=${approvalMode}`)
            ? { launchApprovalModeApplied: approvalMode }
            : {}),
        };
      } catch (cause) {
        lastError = cause;
        try {
          await client.close();
        } catch (closeCause) {
          reportClientCloseFailure(closeCause, { phase: "connect" });
        }
      }
    }
    if (approvalMode === "plan") {
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "initialize",
        detail:
          "Gemini CLI could not start ACP with --approval-mode=plan. Upgrade Gemini CLI to a version that supports Plan Mode, then restart Ace.",
        cause: lastError,
      });
    }
    throw lastError;
  };

  const authenticateGeminiIfRequired = async (
    client: AcpClient,
    metadata: GeminiSessionMetadata,
    env: NodeJS.ProcessEnv,
  ): Promise<void> => {
    const auth = preferredAuthMethod(metadata.authMethods, env);
    if (!auth) {
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "authenticate",
        detail: describeGeminiAuthRequirement(metadata),
      });
    }
    await client.request(
      "authenticate",
      {
        methodId: auth.methodId,
        ...(auth.meta ? { _meta: auth.meta } : {}),
      },
      { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
    );
  };

  const startOrLoadGeminiSession = async (
    client: AcpClient,
    metadata: GeminiSessionMetadata,
    input: ProviderSessionStartInput,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpServers: ReadonlyArray<GeminiAcpMcpServer>,
  ): Promise<{
    readonly sessionId: string;
    readonly metadata: GeminiSessionMetadata;
    readonly method: "session/fork" | "session/resume" | "session/load" | "session/new" | string;
  }> => {
    const resumeSessionId = readGeminiResumeCursor(input.resumeCursor);
    const forkSourceSessionId = readGeminiResumeCursor(input.forkSource?.resumeCursor);
    const canForkSession = forkSourceSessionId !== undefined && metadata.forkSession;
    const sideConversationMethod =
      forkSourceSessionId !== undefined && !metadata.forkSession
        ? metadata.sideConversationMethods[0]
        : undefined;
    const canResumeSession = resumeSessionId !== undefined && metadata.resumeSession;
    const canLoadSession = resumeSessionId !== undefined && metadata.loadSession;
    const newSessionParams = {
      cwd,
      mcpServers,
    };

    const execute = async (
      method: "session/fork" | "session/resume" | "session/load" | "session/new" | string,
      params: {
        readonly cwd: string;
        readonly mcpServers: ReadonlyArray<GeminiAcpMcpServer>;
        readonly sessionId?: string;
        readonly sourceSessionId?: string;
        readonly parentSessionId?: string;
      },
    ) => {
      const result = await client.request(method, params, {
        timeoutMs: ACP_CONTROL_TIMEOUT_MS,
      });
      const resultRecord = asObject(result);
      const sessionId =
        asString(resultRecord?.sessionId) ??
        (method === "session/resume" || method === "session/load" ? resumeSessionId : undefined);
      if (!sessionId) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "Gemini ACP did not return a session id.",
        });
      }
      return {
        sessionId,
        metadata: updateMetadataFromSessionResult(metadata, result),
        method,
      };
    };

    const executeWithAuthRetry = async (
      method: "session/fork" | "session/resume" | "session/load" | "session/new" | string,
      params: {
        readonly cwd: string;
        readonly mcpServers: ReadonlyArray<GeminiAcpMcpServer>;
        readonly sessionId?: string;
        readonly sourceSessionId?: string;
        readonly parentSessionId?: string;
      },
    ) => {
      try {
        return await execute(method, params);
      } catch (cause) {
        if (!isGeminiAuthRequiredError(cause)) {
          throw cause;
        }
        await authenticateGeminiIfRequired(client, metadata, env);
        return await execute(method, params);
      }
    };

    if (canForkSession) {
      try {
        return await executeWithAuthRetry("session/fork", {
          ...newSessionParams,
          sessionId: forkSourceSessionId,
        });
      } catch (cause) {
        if (!isMissingGeminiSessionError(cause)) {
          throw cause;
        }
        return await executeWithAuthRetry("session/new", newSessionParams);
      }
    }

    if (sideConversationMethod && forkSourceSessionId) {
      try {
        return await executeWithAuthRetry(sideConversationMethod, {
          ...newSessionParams,
          sessionId: forkSourceSessionId,
          sourceSessionId: forkSourceSessionId,
          parentSessionId: forkSourceSessionId,
        });
      } catch (cause) {
        if (!isMissingGeminiSessionError(cause)) {
          throw cause;
        }
        return await executeWithAuthRetry("session/new", newSessionParams);
      }
    }

    if (canLoadSession) {
      if (canResumeSession) {
        try {
          return await executeWithAuthRetry("session/resume", {
            ...newSessionParams,
            sessionId: resumeSessionId,
          });
        } catch (cause) {
          if (!isMissingGeminiSessionError(cause)) {
            throw cause;
          }
          return await executeWithAuthRetry("session/new", newSessionParams);
        }
      }

      try {
        return await executeWithAuthRetry("session/load", {
          ...newSessionParams,
          sessionId: resumeSessionId,
        });
      } catch (cause) {
        if (!isMissingGeminiSessionError(cause)) {
          throw cause;
        }
        return await executeWithAuthRetry("session/new", newSessionParams);
      }
    }

    if (canResumeSession) {
      try {
        return await executeWithAuthRetry("session/resume", {
          ...newSessionParams,
          sessionId: resumeSessionId,
        });
      } catch (cause) {
        if (!isMissingGeminiSessionError(cause)) {
          throw cause;
        }
        return await executeWithAuthRetry("session/new", newSessionParams);
      }
    }

    return await executeWithAuthRetry("session/new", newSessionParams);
  };

  const finalizeContextOnClose = (
    context: GeminiSessionContext,
    input: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    },
  ) => {
    if (context.closed) {
      return;
    }
    context.closed = true;
    if (context.activeTurn) {
      completeTurn(
        context,
        context.activeTurn.interruptedRequested
          ? {
              state: "interrupted",
              stopReason: "cancelled",
            }
          : {
              state: "failed",
              errorMessage: `Gemini ACP process exited (code=${input.code ?? "null"}, signal=${input.signal ?? "null"})`,
            },
      );
    }
    emit(
      baseEvent(context, {
        type: "session.exited",
        payload: {
          reason: context.stopRequested
            ? "Session stopped"
            : `Gemini ACP exited (code=${input.code ?? "null"}, signal=${input.signal ?? "null"})`,
          exitKind: context.stopRequested ? "graceful" : "error",
          recoverable: !context.stopRequested,
        },
      }),
    );
    if (!context.stopRequested) {
      emit(
        baseEvent(context, {
          type: "runtime.error",
          payload: {
            ...buildRuntimeErrorPayload({
              message: `Gemini ACP exited unexpectedly (code=${input.code ?? "null"}, signal=${input.signal ?? "null"})`,
              class: "transport_error",
            }),
          },
        }),
      );
    }
    if (sessions.get(context.threadId) === context) {
      sessions.delete(context.threadId);
    }
  };

  const startGeminiSessionContext = async (
    input: ProviderSessionStartInput,
  ): Promise<GeminiSessionContext> => {
    const settings = await runPromise(serverSettingsService.getSettings);
    const geminiSettings = resolveProviderSettings(settings, PROVIDER, input.providerInstanceId);
    const instanceEnv = {
      ...process.env,
      ...geminiSettings.launchEnv,
      ...(geminiSettings.configDir ? { GEMINI_CLI_HOME: geminiSettings.configDir } : {}),
    };
    const cwd = input.cwd ?? serverConfig.cwd;
    await ensureGeminiProjectRegistry(geminiSettings.configDir);
    const acpMcpServers = await readGeminiAcpMcpServers({
      cwd,
      geminiHome: geminiSettings.configDir,
    });
    const builtInSubagentCommands = geminiBuiltInSubagentCommands({
      cwd,
      home: geminiSettings.configDir,
    });
    const launchApprovalMode = geminiLaunchApprovalModeForSession(
      input.runtimeMode,
      input.interactionMode,
    );
    const {
      client,
      metadata: initializedMetadata,
      launchApprovalModeApplied,
    } = await startInitializedGeminiClient(
      geminiSettings.binaryPath,
      cwd,
      launchApprovalMode,
      instanceEnv,
    );
    const initializedMetadataWithSettings: GeminiSessionMetadata = {
      ...initializedMetadata,
      builtInSubagentCommands,
    };

    let contextRef: GeminiSessionContext | null = null;
    client.setNotificationHandler((notification) => {
      if (contextRef) {
        handleGeminiNotification(contextRef, notification);
      }
    });
    client.setRequestHandler((request) => {
      if (!contextRef) {
        client.respondError(request.id, -32000, "Gemini session is not ready.");
        return;
      }
      if (request.method === "session/request_permission") {
        void handleGeminiPermissionRequest(contextRef, request).catch((cause) => {
          client.respondError(
            request.id,
            -32000,
            toMessage(cause, "Failed to handle Gemini permission request"),
          );
        });
        return;
      }
      if (isGeminiUserInputRequestMethod(request.method)) {
        handleGeminiUserInputRequest(contextRef, request);
        return;
      }
      client.respondError(request.id, -32601, `Unsupported ACP client request: ${request.method}`);
    });
    client.setProtocolErrorHandler((error) => {
      if (contextRef) {
        emit(
          baseEvent(contextRef, {
            type: "runtime.error",
            payload: {
              ...buildRuntimeErrorPayload({
                message: toMessage(error, "Gemini ACP protocol error"),
                cause: error,
                class: "transport_error",
              }),
            },
          }),
        );
      }
    });

    try {
      const started = await startOrLoadGeminiSession(
        client,
        initializedMetadataWithSettings,
        input,
        cwd,
        instanceEnv,
        acpMcpServers,
      );

      const createdAt = isoNow();
      const session: ProviderSession = {
        provider: PROVIDER,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model:
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : DEFAULT_MODEL_BY_PROVIDER.gemini,
        threadId: input.threadId,
        resumeCursor: {
          sessionId: started.sessionId,
        },
        createdAt,
        updatedAt: createdAt,
      };

      const context: GeminiSessionContext = {
        threadId: input.threadId,
        client,
        sessionId: started.sessionId,
        session,
        metadata: started.metadata,
        ...(launchApprovalModeApplied ? { launchApprovalModeApplied } : {}),
        turns: [],
        replayTurns: cloneReplayTurns(input.replayTurns),
        sequenceTieBreakersByTimestampMs: new Map(),
        nextFallbackSessionSequence: 0,
        activeTurn: null,
        pendingPermissions: new Map(),
        pendingUserInputs: new Map(),
        totalProcessedTokens: 0,
        pendingBootstrapReset: false,
        closed: false,
        stopRequested: false,
      };
      context.pendingBootstrapReset =
        context.replayTurns.length > 0 && started.method === "session/new";
      contextRef = context;
      client.setCloseHandler((close) => finalizeContextOnClose(context, close));

      sessions.set(input.threadId, context);

      emit(
        baseEvent(context, {
          type: "session.configured",
          payload: {
            config: geminiSessionConfigSnapshot(context.metadata),
          },
        }),
      );
      if (acpMcpServers.length > 0) {
        emit(
          baseEvent(context, {
            type: "mcp.status.updated",
            payload: {
              status: {
                provider: PROVIDER,
                mcpServers: geminiConfiguredMcpStatus(acpMcpServers),
              },
            },
          }),
        );
      }
      emit(
        baseEvent(context, {
          type: "session.started",
          payload: {
            resume: context.session.resumeCursor,
          },
        }),
      );
      emit(
        baseEvent(context, {
          type: "thread.started",
          payload: {
            providerThreadId: context.sessionId,
          },
        }),
      );

      await syncGeminiSessionState(context, {
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        modelSelection: input.modelSelection,
      });

      return context;
    } catch (cause) {
      try {
        await client.close();
      } catch (closeCause) {
        reportClientCloseFailure(closeCause, { phase: "startSession" });
      }
      throw cause;
    }
  };

  const shouldRestartGeminiForInteractionMode = (
    context: GeminiSessionContext,
    runtimeMode: ProviderSession["runtimeMode"],
    interactionMode: ProviderSendTurnInput["interactionMode"],
    modelSelection:
      | ProviderSessionStartInput["modelSelection"]
      | ProviderSendTurnInput["modelSelection"]
      | undefined,
  ): boolean => {
    if (explicitGeminiModeId(modelSelection)) {
      return false;
    }
    const desiredLaunchApprovalMode = geminiLaunchApprovalModeForSession(
      runtimeMode,
      interactionMode,
    );
    const desiredModeId = resolveDesiredModeId(context.metadata, runtimeMode, interactionMode);
    if (context.launchApprovalModeApplied === "plan" && desiredLaunchApprovalMode !== "plan") {
      return true;
    }
    return (
      context.launchApprovalModeApplied !== desiredLaunchApprovalMode &&
      (desiredLaunchApprovalMode === "plan" || !desiredModeId)
    );
  };

  const restartGeminiSessionWithInput = async (
    context: GeminiSessionContext,
    input: ProviderSessionStartInput,
    phase: string,
  ): Promise<GeminiSessionContext> => {
    context.stopRequested = true;
    if (sessions.get(context.threadId) === context) {
      sessions.delete(context.threadId);
    }
    try {
      await context.client.close();
    } catch (cause) {
      reportClientCloseFailure(cause, { phase });
    }

    return await startGeminiSessionContext(input);
  };

  const restartGeminiSessionForStartInput = async (
    context: GeminiSessionContext,
    input: ProviderSessionStartInput,
  ): Promise<GeminiSessionContext> => {
    if (context.activeTurn) {
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "startSession",
        detail: `Gemini session is already running turn '${context.activeTurn.id}'. Wait for it to finish or interrupt it before changing approval mode.`,
      });
    }

    const restartInput: ProviderSessionStartInput = {
      threadId: input.threadId,
      provider: input.provider ?? PROVIDER,
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : context.session.cwd ? { cwd: context.session.cwd } : {}),
      ...(input.threadTitle ? { threadTitle: input.threadTitle } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
      ...(input.resumeCursor !== undefined
        ? { resumeCursor: input.resumeCursor }
        : context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      ...(input.replayTurns !== undefined
        ? { replayTurns: input.replayTurns }
        : context.replayTurns.length > 0
          ? { replayTurns: context.replayTurns }
          : {}),
    };

    return await restartGeminiSessionWithInput(context, restartInput, "restartForStartMode");
  };

  const restartGeminiSessionForInteractionMode = async (
    context: GeminiSessionContext,
    input: ProviderSendTurnInput,
    interactionMode: ProviderSendTurnInput["interactionMode"],
  ): Promise<GeminiSessionContext> =>
    await restartGeminiSessionWithInput(
      context,
      {
        provider: PROVIDER,
        threadId: input.threadId,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        runtimeMode: context.session.runtimeMode,
        ...(interactionMode ? { interactionMode } : {}),
        ...(context.session.resumeCursor ? { resumeCursor: context.session.resumeCursor } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        replayTurns: context.replayTurns,
      },
      "restartForTurnMode",
    );

  const startSession: GeminiAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
    Effect.tryPromise({
      try: async () => {
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected Gemini model selection, received '${input.modelSelection.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.closed) {
          if (
            shouldRestartGeminiForInteractionMode(
              existing,
              input.runtimeMode,
              input.interactionMode,
              input.modelSelection,
            )
          ) {
            const context = await restartGeminiSessionForStartInput(existing, input);
            return context.session;
          }
          await syncGeminiSessionState(existing, {
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection: input.modelSelection,
          });
          existing.session = {
            ...existing.session,
            runtimeMode: input.runtimeMode,
            ...(input.modelSelection?.provider === PROVIDER
              ? { model: input.modelSelection.model }
              : {}),
            updatedAt: isoNow(),
          };
          return existing.session;
        }

        const context = await startGeminiSessionContext(input);
        return context.session;
      },
      catch: (cause) =>
        isProviderAdapterValidationError(cause) || isProviderAdapterRequestError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: toMessage(cause, "Gemini session start failed"),
              cause,
            }),
    });

  const sendTurn: GeminiAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.tryPromise({
      try: async () => {
        let context = sessions.get(input.threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Expected Gemini model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        if (context.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Gemini session is already running turn '${context.activeTurn.id}'. Wait for it to finish or interrupt it before starting another turn.`,
          });
        }
        if (
          shouldRestartGeminiForInteractionMode(
            context,
            context.session.runtimeMode,
            input.interactionMode,
            input.modelSelection,
          )
        ) {
          context = await restartGeminiSessionForInteractionMode(
            context,
            input,
            input.interactionMode,
          );
        }

        const turnId = TurnId.makeUnsafe(`gemini-turn:${randomUUID()}`);
        const assistantItemId = RuntimeItemId.makeUnsafe(`gemini-assistant:${randomUUID()}`);
        const reasoningItemId = RuntimeItemId.makeUnsafe(`gemini-reasoning:${randomUUID()}`);
        const previousSessionStatus = context.session.status;
        const previousSessionActiveTurnId = context.session.activeTurnId;
        const previousSessionLastError = context.session.lastError;

        context.activeTurn = {
          id: turnId,
          started: false,
          startedAtMs: Date.now(),
          inputText: input.input ?? "",
          attachmentNames: (input.attachments ?? []).map((attachment) => attachment.name),
          assistantText: "",
          items: [],
          assistantItemId,
          assistantStarted: false,
          reasoningItemId,
          reasoningStarted: false,
          toolItems: new Map(),
          interruptedRequested: false,
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: isoNow(),
        };

        try {
          await syncGeminiSessionState(context, {
            runtimeMode: context.session.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection: input.modelSelection,
          });

          const promptInput = context.pendingBootstrapReset
            ? {
                ...input,
                input: buildBootstrapPromptFromReplayTurns(
                  context.replayTurns,
                  input.input ?? "Please analyze the attached files.",
                  ROLLBACK_BOOTSTRAP_MAX_CHARS,
                ).text,
              }
            : input;
          const promptContent = buildPromptContent(promptInput, serverConfig.attachmentsDir);
          if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: "Gemini session closed before the reserved turn could start.",
            });
          }

          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: isoNow(),
            model:
              input.modelSelection?.provider === PROVIDER
                ? input.modelSelection.model
                : (context.session.model ?? DEFAULT_MODEL_BY_PROVIDER.gemini),
          };
          context.activeTurn.started = true;

          emit(
            baseEvent(context, {
              type: "turn.started",
              turnId,
              payload: context.session.model ? { model: context.session.model } : {},
            }),
          );

          void context.client
            .request("session/prompt", {
              sessionId: context.sessionId,
              prompt: promptContent,
            })
            .then(async (result) => {
              context.pendingBootstrapReset = false;
              if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
                return;
              }
              const resultRecord = asObject(result);
              const stopReason = asString(resultRecord?.stopReason) ?? null;
              const resultUsage =
                asObject(resultRecord?.usage) ??
                asObject(resultRecord?.usageMetadata) ??
                asObject(resultRecord?.usage_metadata);
              const resultQuota =
                asObject(asObject(resultRecord?._meta)?.quota) ?? asObject(resultRecord?.quota);
              const rawUsage =
                resultUsage && resultQuota
                  ? {
                      ...resultQuota,
                      ...resultUsage,
                    }
                  : (resultUsage ?? resultQuota);
              if (input.interactionMode === "plan") {
                await refreshProposedPlanFromGeminiFiles(context, context.activeTurn);
              }
              if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
                return;
              }
              if (stopReason === "cancelled" || context.activeTurn.interruptedRequested) {
                completeTurn(context, {
                  state: "interrupted",
                  stopReason,
                  ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
                });
                return;
              }
              completeTurn(context, {
                state: "completed",
                stopReason,
                ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
              });
            })
            .catch((cause) => {
              if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
                return;
              }
              if (context.activeTurn.interruptedRequested && cause instanceof AcpRequestError) {
                completeTurn(context, {
                  state: "interrupted",
                  stopReason: "cancelled",
                });
                return;
              }
              completeTurn(context, {
                state: "failed",
                errorMessage: toMessage(cause, "Gemini prompt failed"),
              });
              emit(
                baseEvent(context, {
                  type: "runtime.error",
                  turnId,
                  payload: {
                    ...buildRuntimeErrorPayload({
                      message: toMessage(cause, "Gemini prompt failed"),
                      cause,
                      class: "provider_error",
                    }),
                  },
                }),
              );
            });
        } catch (cause) {
          if (context.activeTurn?.id === turnId) {
            context.activeTurn = null;
            context.session = {
              ...context.session,
              status: previousSessionStatus,
              activeTurnId: previousSessionActiveTurnId,
              updatedAt: isoNow(),
              ...(previousSessionLastError !== undefined
                ? { lastError: previousSessionLastError }
                : { lastError: undefined }),
            };
          }
          throw cause;
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      },
      catch: (cause) =>
        isProviderAdapterValidationError(cause) ||
        isProviderAdapterRequestError(cause) ||
        isProviderAdapterSessionNotFoundError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: toMessage(cause, "Gemini sendTurn failed"),
              cause,
            }),
    });

  const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: async () => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (!context.activeTurn) {
          return;
        }
        if (turnId && context.activeTurn.id !== turnId) {
          return;
        }
        const activeTurnId = context.activeTurn.id;
        context.activeTurn.interruptedRequested = true;
        context.client.notify("session/cancel", {
          sessionId: context.sessionId,
        });
        cancelPendingPermissionsForTurn(context, activeTurnId);
        completeTurn(context, {
          state: "interrupted",
          stopReason: "cancelled",
        });
      },
      catch: (cause) =>
        isProviderAdapterSessionNotFoundError(cause) || isProviderAdapterRequestError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/cancel",
              detail: toMessage(cause, "Gemini turn interrupt failed"),
              cause,
            }),
    });

  const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const pending = context.pendingPermissions.get(requestId);
      if (!pending) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending Gemini approval request: ${requestId}`,
        });
      }

      const selectedOption = selectPermissionOption(pending.options, decision);
      if (!selectedOption) {
        context.client.respond(pending.jsonRpcId, {
          outcome: {
            outcome: "cancelled",
          },
        });
        resolvePendingPermission(context, pending, {
          decision: "cancel",
        });
        return;
      }

      context.client.respond(pending.jsonRpcId, {
        outcome: {
          outcome: "selected",
          optionId: selectedOption.optionId,
        },
      });
      resolvePendingPermission(context, pending, {
        decision,
        optionId: selectedOption.optionId,
        kind: selectedOption.kind,
      });
    });

  const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
    threadId: ThreadId,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Unknown pending Gemini user-input request: ${requestId}`,
        });
      }
      context.pendingUserInputs.delete(requestId);
      const firstAnswer = firstGeminiUserInputAnswer(answers);
      context.client.respond(pending.jsonRpcId, {
        answers,
        answer: firstAnswer,
        response: firstAnswer,
      });
      emitGeminiUserInputResolved(context, pending, answers);
    });

  const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
    Effect.tryPromise(async () => {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      context.stopRequested = true;
      if (context.activeTurn) {
        cancelPendingPermissionsForTurn(context, context.activeTurn.id);
        cancelPendingUserInputsForTurn(context, context.activeTurn.id);
      }
      await closeGeminiProviderSession(context, "stopSession");
      await context.client.close();
    });

  const listSessions: GeminiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));

  const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    });

  const rollbackThread: GeminiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (context.activeTurn) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Gemini cannot roll back while a turn is still running.",
        });
      }

      const nextLength = Math.max(0, context.turns.length - numTurns);
      const trimmedTurns = context.turns.slice(0, nextLength).map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      }));
      const trimmedReplayTurns = context.replayTurns.slice(0, nextLength).map((turn) => {
        if (turn.assistantResponse !== undefined) {
          return {
            prompt: turn.prompt,
            attachmentNames: [...turn.attachmentNames],
            assistantResponse: turn.assistantResponse,
          };
        }

        return {
          prompt: turn.prompt,
          attachmentNames: [...turn.attachmentNames],
        };
      });

      const restartInput = {
        provider: PROVIDER,
        threadId,
        runtimeMode: context.session.runtimeMode,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        ...(context.session.model
          ? {
              modelSelection: {
                provider: PROVIDER,
                model: context.session.model,
              } as const,
            }
          : {}),
      };

      yield* stopSession(threadId);
      sessions.delete(threadId);
      yield* startSession(restartInput);

      const restarted = sessions.get(threadId);
      if (!restarted) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Gemini rollback failed to recreate the session.",
        });
      }

      restarted.turns.push(...trimmedTurns);
      restarted.replayTurns.push(...trimmedReplayTurns);
      restarted.pendingBootstrapReset = trimmedReplayTurns.length > 0;

      return {
        threadId,
        turns: restarted.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    },
  );

  const stopAll: GeminiAdapterShape["stopAll"] = () =>
    Effect.tryPromise(async () => {
      for (const context of sessions.values()) {
        context.stopRequested = true;
        if (context.activeTurn) {
          cancelPendingPermissionsForTurn(context, context.activeTurn.id);
          cancelPendingUserInputsForTurn(context, context.activeTurn.id);
        }
        try {
          await closeGeminiProviderSession(context, "stopAll");
          await context.client.close();
        } catch (cause) {
          reportClientCloseFailure(cause, {
            phase: "stopAll",
            threadId: context.session.threadId,
          });
        }
      }
      sessions.clear();
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      sessionModelOptionsSwitch: "in-session",
      liveTurnDiffMode: "reconstructed",
      reviewChangesMode: "provider",
      reviewSurface: "editor-native",
      approvalRequestsMode: "native",
      turnSteeringMode: "queued-message",
      transcriptAuthority: "local",
      historyAuthority: "project-local",
      sessionResumeMode: "local-replay",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies GeminiAdapterShape;
});

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter);
