import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  PI_THOUGHT_LEVEL_OPTIONS,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type PiThoughtLevel,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionConfigOption,
  type ProviderSessionStartInput,
  type ProviderSlashCommand,
  type ProviderTurnStartResult,
  type UserInputQuestion,
} from "@ace/contracts";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildBootstrapPromptFromReplayTurns,
  cloneReplayTurns,
  type TranscriptReplayTurn,
} from "../providerTranscriptBootstrap.ts";
import { providerFallbackSlashCommands } from "@ace/shared/providerSlashCommands";
import { startPiRpcClient, type PiRpcClient, type PiRpcEvent } from "../piRpcClient.ts";
import { type PiAdapterShape, PiAdapter } from "../Services/PiAdapter.ts";

const PROVIDER = "pi" as const;
const PI_RPC_CONTROL_TIMEOUT_MS = 20_000;
const BOOTSTRAP_MAX_CHARS = 24_000;
const MAX_TURN_ITEMS_PER_TURN = 512;
const PI_PROPOSED_PLAN_START_REGEX = /<!--\s*ACE_PROPOSED_PLAN_START(?:\s*--\s*>?)?/i;
const PI_PROPOSED_PLAN_END_REGEX = /<!--\s*ACE_PROPOSED_PLAN_END(?:\s*--\s*>?)?/i;
const PI_PROPOSED_PLAN_BLOCK_REGEX =
  /<!--\s*ACE_PROPOSED_PLAN_START(?:\s*--\s*>?)?\s*([\s\S]*?)\s*<!--\s*ACE_PROPOSED_PLAN_END(?:\s*--\s*>?)?/i;
const PI_PLAN_MODE_PROMPT_PREAMBLE = [
  "Ace is running Pi in provider-emulated planning mode.",
  "Do not run commands, call tools, modify files, or claim that code has been changed.",
  "Think through the task and produce an implementation plan only.",
  "If you need clarification, ask concise questions and do not emit a proposed plan block.",
  "When you are ready to propose a plan, place the plan markdown between these exact markers:",
  "<!-- ACE_PROPOSED_PLAN_START -->",
  "<!-- ACE_PROPOSED_PLAN_END -->",
  "Inside the markers, start with a top-level markdown heading and then list short actionable steps.",
].join("\n");

type PiAvailableCommand = {
  readonly name: string;
  readonly description?: string;
  readonly input?: {
    readonly hint?: string;
  };
};

type PiModel = {
  readonly slug: string;
  readonly provider?: string;
  readonly modelId: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
};

type PiSessionMetadata = {
  availableCommands: ReadonlyArray<PiAvailableCommand>;
  availableModels: ReadonlyArray<PiModel>;
  currentModelSlug?: string | undefined;
  currentThinkingLevel?: string | undefined;
  currentModelReasoning?: boolean | undefined;
  currentContextWindow?: number | undefined;
};

type PiToolItemKind = "command_execution" | "file_change" | "dynamic_tool_call";

type PiToolItemState = {
  readonly itemId: RuntimeItemId;
  readonly itemType: PiToolItemKind;
  completed: boolean;
  lastOutput: string;
};

type PiTurnState = {
  readonly id: TurnId;
  readonly inputText: string;
  readonly attachmentNames: ReadonlyArray<string>;
  readonly interactionMode: ProviderSessionStartInput["interactionMode"];
  readonly startedAtMs: number;
  assistantText: string;
  visibleAssistantText: string;
  reasoningText: string;
  readonly items: Array<unknown>;
  readonly toolItems: Map<string, PiToolItemState>;
  lastProposedPlanMarkdown?: string | undefined;
  planToolWarningEmitted: boolean;
  interruptedRequested: boolean;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
};

type PendingPiUserInput =
  | {
      readonly requestId: ApprovalRequestId;
      readonly rpcRequestId: string;
      readonly method: "confirm";
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly turnId?: TurnId | undefined;
    }
  | {
      readonly requestId: ApprovalRequestId;
      readonly rpcRequestId: string;
      readonly method: "select";
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly turnId?: TurnId | undefined;
    };

type PiSessionContext = {
  readonly threadId: ThreadId;
  readonly client: PiRpcClient;
  session: ProviderSession;
  metadata: PiSessionMetadata;
  readonly turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  readonly replayTurns: Array<TranscriptReplayTurn>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingPiUserInput>;
  readonly emittedWarnings: Set<"plan" | "approval-required">;
  activeTurn: PiTurnState | null;
  pendingBootstrapReset: boolean;
  closed: boolean;
  stopRequested: boolean;
};

type PiToolContent = {
  readonly type?: string;
  readonly text?: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

const PI_THOUGHT_LEVEL_SET = new Set<string>(PI_THOUGHT_LEVEL_OPTIONS);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function modelSlug(provider: string | undefined, modelId: string): string {
  return provider ? `${provider}/${modelId}` : modelId;
}

function canonicalizePiModelToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function splitPiRequestedModelSlug(slug: string): {
  readonly provider?: string;
  readonly modelId: string;
} {
  const slashIndex = slug.indexOf("/");
  if (slashIndex > 0 && slashIndex < slug.length - 1) {
    return {
      provider: slug.slice(0, slashIndex),
      modelId: slug.slice(slashIndex + 1),
    };
  }
  return { modelId: slug };
}

function rankPiRequestedProviderMatch(
  requestedProvider: string | undefined,
  candidate: Pick<PiModel, "provider" | "modelId">,
): number {
  if (!requestedProvider) {
    return 0;
  }
  const normalizedRequestedProvider = requestedProvider.trim().toLowerCase();
  const normalizedCandidateProvider = candidate.provider?.trim().toLowerCase();
  const normalizedCandidateModelId = candidate.modelId.trim().toLowerCase();

  if (normalizedCandidateProvider === normalizedRequestedProvider) {
    return 5;
  }
  if (normalizedCandidateProvider?.startsWith(`${normalizedRequestedProvider}-`)) {
    return 4;
  }
  if (normalizedCandidateProvider?.includes(normalizedRequestedProvider)) {
    return 3;
  }
  if (
    normalizedRequestedProvider === "anthropic" &&
    normalizedCandidateModelId.startsWith("claude-")
  ) {
    return 2;
  }
  if (normalizedRequestedProvider === "openai" && normalizedCandidateModelId.startsWith("gpt-")) {
    return 2;
  }
  if (
    normalizedRequestedProvider === "google" &&
    normalizedCandidateModelId.startsWith("gemini-")
  ) {
    return 2;
  }
  return 0;
}

function normalizePiModel(value: unknown): PiModel | null {
  const record = asObject(value);
  const modelId = asString(record?.id) ?? asString(record?.modelId);
  if (!modelId) {
    return null;
  }
  const provider = asString(record?.provider);
  return {
    slug: modelSlug(provider, modelId),
    ...(provider ? { provider } : {}),
    modelId,
    ...(asString(record?.name) ? { name: asString(record?.name)! } : {}),
    ...(asString(record?.description) ? { description: asString(record?.description)! } : {}),
    ...(typeof record?.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
    ...(asNumber(record?.contextWindow) ? { contextWindow: asNumber(record?.contextWindow)! } : {}),
  };
}

function normalizeAvailableModels(value: unknown): ReadonlyArray<PiModel> {
  const models: PiModel[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(value)) {
    const model = normalizePiModel(entry);
    if (!model || seen.has(model.slug)) {
      continue;
    }
    seen.add(model.slug);
    models.push(model);
  }
  return models;
}

function normalizeAvailableCommands(value: unknown): ReadonlyArray<PiAvailableCommand> {
  return asArray(value).flatMap((entry) => {
    const record = asObject(entry);
    const name = asString(record?.name);
    if (!name) {
      return [];
    }
    return [
      {
        name,
        ...(asString(record?.description) ? { description: asString(record?.description)! } : {}),
      },
    ];
  });
}

function normalizeProviderCommands(
  commands: ReadonlyArray<PiAvailableCommand>,
): ReadonlyArray<ProviderSlashCommand> {
  const seen = new Set<string>();
  const normalized: ProviderSlashCommand[] = [];
  for (const command of commands) {
    const key = command.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      name: command.name,
      kind: "provider",
      ...(command.description ? { description: command.description } : {}),
      ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
    });
  }
  return normalized;
}

function normalizePiThoughtLevel(value: string | undefined): PiThoughtLevel | undefined {
  return value && PI_THOUGHT_LEVEL_SET.has(value) ? (value as PiThoughtLevel) : undefined;
}

function requestedPiThoughtLevel(
  modelSelection:
    | ProviderSessionStartInput["modelSelection"]
    | ProviderSendTurnInput["modelSelection"]
    | undefined,
): PiThoughtLevel | undefined {
  if (!modelSelection || modelSelection.provider !== PROVIDER) {
    return undefined;
  }
  return normalizePiThoughtLevel(
    modelSelection.options?.thoughtLevel ?? modelSelection.options?.reasoningEffort,
  );
}

function currentModel(metadata: PiSessionMetadata): PiModel | undefined {
  return metadata.availableModels.find((model) => model.slug === metadata.currentModelSlug);
}

function stripPiProposedPlanBlock(text: string): string {
  const completeBlockStripped = text.replace(PI_PROPOSED_PLAN_BLOCK_REGEX, "");
  const startMatch = PI_PROPOSED_PLAN_START_REGEX.exec(completeBlockStripped);
  if (!startMatch || startMatch.index === undefined) {
    return completeBlockStripped.trimEnd();
  }
  const beforePlanBlock = completeBlockStripped.slice(0, startMatch.index);
  const afterPlanStart = completeBlockStripped.slice(startMatch.index + startMatch[0].length);
  const endMatch = PI_PROPOSED_PLAN_END_REGEX.exec(afterPlanStart);
  if (!endMatch || endMatch.index === undefined) {
    return beforePlanBlock.trimEnd();
  }
  return `${beforePlanBlock}${afterPlanStart.slice(endMatch.index + endMatch[0].length)}`.trimEnd();
}

function normalizePiProposedPlanMarkdown(markdown: string): string {
  return markdown
    .replace(/^>\s*/, "")
    .replace(/^(#{1,6})(?=\S)/gm, "$1 ")
    .replace(/(?<!\d)(\d+)\.(?=\S)/g, "$1. ")
    .replace(/([,:;])(?=\S)/g, "$1 ")
    .trim();
}

function buildConfigOptions(
  metadata: PiSessionMetadata,
): ReadonlyArray<ProviderSessionConfigOption> {
  const configOptions: ProviderSessionConfigOption[] = [];
  if (metadata.availableModels.length > 0) {
    const currentValue =
      metadata.currentModelSlug ??
      metadata.availableModels[0]?.slug ??
      DEFAULT_MODEL_BY_PROVIDER.pi;
    configOptions.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: metadata.availableModels.map((model) => ({
        value: model.slug,
        name: model.name ?? model.slug,
        ...(model.description ? { description: model.description } : {}),
      })),
    });
  }
  if (
    metadata.currentThinkingLevel !== undefined ||
    metadata.currentModelReasoning === true ||
    metadata.availableModels.some((model) => model.reasoning === true)
  ) {
    configOptions.push({
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: metadata.currentThinkingLevel ?? "medium",
      options: PI_THOUGHT_LEVEL_OPTIONS.map((level) => ({
        value: level,
        name: level === "xhigh" ? "Extra High" : level[0]!.toUpperCase() + level.slice(1),
      })),
    });
  }
  return configOptions;
}

function configSnapshot(context: PiSessionContext): Record<string, unknown> {
  return {
    configOptions: buildConfigOptions(context.metadata),
    availableCommands: normalizeProviderCommands(context.metadata.availableCommands),
  };
}

function createSessionMetadata(input: {
  readonly state?: unknown;
  readonly models?: unknown;
  readonly commands?: unknown;
}): PiSessionMetadata {
  const state = asObject(input.state);
  const availableModels = normalizeAvailableModels(input.models);
  const stateModel = normalizePiModel(state?.model);
  const allModels =
    stateModel && !availableModels.some((model) => model.slug === stateModel.slug)
      ? [stateModel, ...availableModels]
      : availableModels;
  return {
    availableCommands:
      normalizeAvailableCommands(input.commands).length > 0
        ? normalizeAvailableCommands(input.commands)
        : providerFallbackSlashCommands(PROVIDER).map((command) => {
            const normalized: {
              name: string;
              description?: string;
              input?: { hint: string };
            } = {
              name: command.name,
            };
            if (command.description) {
              normalized.description = command.description;
            }
            if (command.inputHint) {
              normalized.input = { hint: command.inputHint };
            }
            return normalized;
          }),
    availableModels: allModels,
    ...(stateModel ? { currentModelSlug: stateModel.slug } : {}),
    ...(asString(state?.thinkingLevel)
      ? { currentThinkingLevel: asString(state?.thinkingLevel)! }
      : {}),
    ...(stateModel?.reasoning !== undefined ? { currentModelReasoning: stateModel.reasoning } : {}),
    ...(stateModel?.contextWindow !== undefined
      ? { currentContextWindow: stateModel.contextWindow }
      : {}),
  };
}

function resolveToolItemType(toolName: string | undefined): PiToolItemKind {
  const normalized = (toolName ?? "").toLowerCase();
  if (normalized === "bash" || normalized === "exec" || normalized === "shell") {
    return "command_execution";
  }
  if (
    normalized.includes("file") ||
    normalized.includes("read") ||
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("delete") ||
    normalized.includes("rename") ||
    normalized.includes("move")
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function streamKindForToolItemType(
  itemType: PiToolItemKind,
): "command_output" | "file_change_output" {
  return itemType === "command_execution" ? "command_output" : "file_change_output";
}

function readTurnItemId(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const { id } = item as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function extractContentText(value: unknown): string {
  return asArray(value)
    .flatMap((entry) => {
      const content = asObject(entry) as PiToolContent | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        return [content.text];
      }
      return [];
    })
    .join("");
}

function readPiAssistantErrorMessage(value: unknown): string | undefined {
  const message = asObject(value);
  if (!message || asString(message.role) !== "assistant") {
    return undefined;
  }
  const stopReason = asString(message.stopReason);
  const errorMessage = asString(message.errorMessage);
  if (stopReason !== "error" && !errorMessage) {
    return undefined;
  }
  return errorMessage ?? (stopReason === "error" ? "Pi turn failed." : undefined);
}

function describeToolTitle(toolName: string | undefined, args: unknown): string | undefined {
  const name = asString(toolName);
  const argRecord = asObject(args);
  const command = asString(argRecord?.command);
  if (name === "bash" && command) {
    return command;
  }
  return name;
}

function resolveModelReference(
  metadata: PiSessionMetadata,
  slug: string,
): { readonly provider: string; readonly modelId: string; readonly slug: string } | null {
  const exactMatch = metadata.availableModels.find(
    (model) => model.slug === slug || model.modelId === slug,
  );
  if (exactMatch?.provider) {
    return {
      provider: exactMatch.provider,
      modelId: exactMatch.modelId,
      slug: exactMatch.slug,
    };
  }
  const requested = splitPiRequestedModelSlug(slug);
  const requestedCanonicalModelId = canonicalizePiModelToken(requested.modelId);
  const normalizedMatches = metadata.availableModels.filter(
    (model) => canonicalizePiModelToken(model.modelId) === requestedCanonicalModelId,
  );
  if (normalizedMatches.length > 0) {
    const bestMatch = [...normalizedMatches].sort((left, right) => {
      const scoreDelta =
        rankPiRequestedProviderMatch(requested.provider, right) -
        rankPiRequestedProviderMatch(requested.provider, left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.slug.localeCompare(right.slug);
    })[0]!;
    if (bestMatch.provider) {
      return {
        provider: bestMatch.provider,
        modelId: bestMatch.modelId,
        slug: bestMatch.slug,
      };
    }
  }
  if (requested.provider) {
    return {
      provider: requested.provider,
      modelId: requested.modelId,
      slug,
    };
  }
  const current = currentModel(metadata);
  if (current?.provider) {
    return {
      provider: current.provider,
      modelId: slug,
      slug: modelSlug(current.provider, slug),
    };
  }
  return null;
}

function promptMessage(input: ProviderSendTurnInput): string {
  if (input.input !== undefined) {
    return input.input;
  }
  return "Analyze the attached image.";
}

function looksLikePlanMarkdown(text: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/m.test(text) && /^(?:[-*+]|\d+\.)\s+\S/m.test(text);
}

function extractPiProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PI_PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const taggedPlanMarkdown = match?.[1] ? normalizePiProposedPlanMarkdown(match[1]) : undefined;
  if (taggedPlanMarkdown && taggedPlanMarkdown.length > 0) {
    return taggedPlanMarkdown;
  }
  const startMatch = text ? PI_PROPOSED_PLAN_START_REGEX.exec(text) : null;
  if (text && startMatch && startMatch.index !== undefined) {
    const afterPlanStart = text.slice(startMatch.index + startMatch[0].length);
    const endMatch = PI_PROPOSED_PLAN_END_REGEX.exec(afterPlanStart);
    const planCandidate = normalizePiProposedPlanMarkdown(
      endMatch?.index === undefined ? afterPlanStart : afterPlanStart.slice(0, endMatch.index),
    );
    if (planCandidate.length > 0) {
      return planCandidate;
    }
  }
  const trimmed = text?.trim();
  if (!trimmed || !looksLikePlanMarkdown(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function wrapPiPlanPrompt(message: string): string {
  const trimmed = message.trim();
  return `${PI_PLAN_MODE_PROMPT_PREAMBLE}\n\nUser request:\n${trimmed.length > 0 ? trimmed : "Provide a proposed implementation plan."}`;
}

function buildUserInputQuestionsForConfirm(
  title: string,
  message: string | undefined,
): ReadonlyArray<UserInputQuestion> {
  return [
    {
      id: "confirm",
      header: title,
      question: message ?? title,
      options: [
        { label: "Confirm", description: "Continue" },
        { label: "Decline", description: "Do not continue" },
      ],
    },
  ];
}

function buildUserInputQuestionsForSelect(
  title: string,
  options: ReadonlyArray<string>,
): ReadonlyArray<UserInputQuestion> {
  return [
    {
      id: "select",
      header: title,
      question: title,
      options: options.map((option) => ({
        label: option,
        description: option,
      })),
    },
  ];
}

export const PiAdapterLive = Layer.effect(
  PiAdapter,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const services = yield* Effect.services();
    const runPromise = Effect.runPromiseWith(services);
    const eventsPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();

    const emit = (event: ProviderRuntimeEvent) => {
      void runPromise(PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid));
    };

    const resolveTurnSnapshot = (
      context: PiSessionContext,
      turnId: TurnId,
    ): { id: TurnId; items: Array<unknown> } => {
      const existing = context.turns.find((turn) => turn.id === turnId);
      if (existing) {
        return existing as { id: TurnId; items: Array<unknown> };
      }
      const created = { id: turnId, items: [] as Array<unknown> };
      context.turns.push(created);
      return created;
    };

    const appendTurnItem = (
      context: PiSessionContext,
      turnId: TurnId | undefined,
      item: unknown,
    ): void => {
      if (!turnId) {
        return;
      }
      const appendInto = (items: Array<unknown>) => {
        const itemId = readTurnItemId(item);
        if (itemId === undefined) {
          items.push(item);
        } else {
          const existingIndex = items.findIndex(
            (candidate) => readTurnItemId(candidate) === itemId,
          );
          if (existingIndex === -1) {
            items.push(item);
          } else {
            items[existingIndex] = item;
          }
        }
        if (items.length > MAX_TURN_ITEMS_PER_TURN) {
          items.splice(0, items.length - MAX_TURN_ITEMS_PER_TURN);
        }
      };

      appendInto(resolveTurnSnapshot(context, turnId).items);
      if (context.activeTurn?.id === turnId) {
        appendInto(context.activeTurn.items);
      }
    };

    const baseEvent = (
      context: PiSessionContext,
      input: {
        readonly type: ProviderRuntimeEvent["type"];
        readonly createdAt?: string;
        readonly turnId?: TurnId;
        readonly requestId?: ApprovalRequestId;
        readonly itemId?: RuntimeItemId;
        readonly rawType?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "pi.rpc.event" | "pi.rpc.command";
        readonly payload: Record<string, unknown>;
      },
    ): ProviderRuntimeEvent =>
      ({
        eventId: EventId.makeUnsafe(`pi:${randomUUID()}`),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: input.createdAt ?? isoNow(),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.rawType
          ? {
              raw: {
                source: input.rawSource ?? "pi.rpc.event",
                messageType: input.rawType,
                payload: input.rawPayload ?? {},
              },
            }
          : {}),
        type: input.type,
        payload: input.payload,
      }) as unknown as ProviderRuntimeEvent;

    const emitSessionConfigured = (
      context: PiSessionContext,
      input?: {
        readonly rawType?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "pi.rpc.event" | "pi.rpc.command";
      },
    ) => {
      emit(
        baseEvent(context, {
          type: "session.configured",
          payload: {
            config: configSnapshot(context),
          },
          ...(input?.rawType ? { rawType: input.rawType } : {}),
          ...(input?.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input?.rawSource ? { rawSource: input.rawSource } : {}),
        }),
      );
    };

    const updateSession = (context: PiSessionContext, patch: Partial<ProviderSession>) => {
      context.session = {
        ...context.session,
        ...patch,
        updatedAt: isoNow(),
      };
    };

    const ensureToolItem = (
      context: PiSessionContext,
      turn: PiTurnState,
      toolCallId: string,
      input: {
        readonly toolName?: string | undefined;
        readonly args?: unknown;
        readonly rawType: string;
        readonly rawPayload?: unknown;
      },
    ): PiToolItemState => {
      const existing = turn.toolItems.get(toolCallId);
      if (existing) {
        return existing;
      }
      const itemType = resolveToolItemType(input.toolName);
      const state: PiToolItemState = {
        itemId: RuntimeItemId.makeUnsafe(`pi-tool:${randomUUID()}`),
        itemType,
        completed: false,
        lastOutput: "",
      };
      turn.toolItems.set(toolCallId, state);
      emit(
        baseEvent(context, {
          type: "item.started",
          turnId: turn.id,
          itemId: state.itemId,
          rawType: input.rawType,
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          payload: {
            itemType,
            status: "inProgress",
            ...(describeToolTitle(input.toolName, input.args)
              ? { title: describeToolTitle(input.toolName, input.args)! }
              : {}),
          },
        }),
      );
      appendTurnItem(context, turn.id, {
        id: String(state.itemId),
        itemType,
        status: "inProgress",
        ...(describeToolTitle(input.toolName, input.args)
          ? { title: describeToolTitle(input.toolName, input.args)! }
          : {}),
      });
      return state;
    };

    const emitToolOutputDelta = (
      context: PiSessionContext,
      turn: PiTurnState,
      toolState: PiToolItemState,
      text: string,
      rawType: string,
      rawPayload: unknown,
    ) => {
      if (!text) {
        return;
      }
      const delta = text.startsWith(toolState.lastOutput)
        ? text.slice(toolState.lastOutput.length)
        : text;
      toolState.lastOutput = text;
      if (!delta) {
        return;
      }
      emit(
        baseEvent(context, {
          type: "content.delta",
          turnId: turn.id,
          itemId: toolState.itemId,
          rawType,
          rawPayload,
          payload: {
            streamKind: streamKindForToolItemType(toolState.itemType),
            delta,
          },
        }),
      );
      appendTurnItem(context, turn.id, {
        kind: streamKindForToolItemType(toolState.itemType),
        text: delta,
        itemId: toolState.itemId,
      });
    };

    const emitUsageSnapshot = async (context: PiSessionContext) => {
      try {
        const stats = asObject(
          await context.client.request("get_session_stats", undefined, {
            timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS,
          }),
        );
        const tokens = asObject(stats?.tokens);
        const inputTokens = asNumber(tokens?.input) ?? 0;
        const outputTokens = asNumber(tokens?.output) ?? 0;
        const cachedInputTokens = asNumber(tokens?.cacheRead);
        const totalProcessedTokens = asNumber(tokens?.total);
        const toolUses = asNumber(stats?.toolCalls);
        const usage = {
          usedTokens:
            asNumber(asObject(stats?.contextUsage)?.tokens) ??
            totalProcessedTokens ??
            inputTokens + outputTokens,
          ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
          ...(context.metadata.currentContextWindow !== undefined
            ? { maxTokens: context.metadata.currentContextWindow }
            : {}),
          inputTokens,
          outputTokens,
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(toolUses !== undefined ? { toolUses } : {}),
          durationMs: Math.max(0, Date.now() - (context.activeTurn?.startedAtMs ?? Date.now())),
          compactsAutomatically: true,
        };
        emit(
          baseEvent(context, {
            type: "thread.token-usage.updated",
            rawType: "get_session_stats",
            rawPayload: stats,
            rawSource: "pi.rpc.command",
            payload: {
              usage,
            },
          }),
        );
      } catch (cause) {
        emit(
          baseEvent(context, {
            type: "runtime.warning",
            payload: {
              message: toMessage(cause, "Unable to read Pi session stats."),
            },
          }),
        );
      }
    };

    const emitUserInputResolved = (
      context: PiSessionContext,
      pending: PendingPiUserInput,
      answers: Record<string, string>,
      input?: {
        readonly rawType?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "pi.rpc.event" | "pi.rpc.command";
      },
    ) => {
      emit(
        baseEvent(context, {
          type: "user-input.resolved",
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId: pending.requestId,
          ...(input?.rawType ? { rawType: input.rawType } : {}),
          ...(input?.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input?.rawSource ? { rawSource: input.rawSource } : {}),
          payload: {
            answers,
          },
        }),
      );
      appendTurnItem(context, pending.turnId, {
        id: String(pending.requestId),
        kind: "user_input",
        answers,
      });
    };

    const cancelPendingUserInputs = (
      context: PiSessionContext,
      input?: {
        readonly turnId?: TurnId;
        readonly notifyProvider?: boolean;
        readonly rawType?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "pi.rpc.event" | "pi.rpc.command";
      },
    ) => {
      for (const [requestId, pending] of context.pendingUserInputs.entries()) {
        if (input?.turnId && pending.turnId !== input.turnId) {
          continue;
        }
        context.pendingUserInputs.delete(requestId);
        if (input?.notifyProvider !== false) {
          context.client.notify("extension_ui_response", {
            id: pending.rpcRequestId,
            cancelled: true,
          });
        }
        emitUserInputResolved(context, pending, {}, input);
      }
    };

    const completeTurn = (
      context: PiSessionContext,
      input: {
        readonly state: "completed" | "failed" | "interrupted" | "cancelled";
        readonly stopReason?: string | null;
        readonly errorMessage?: string;
        readonly rawType?: string;
        readonly rawPayload?: unknown;
      },
    ) => {
      const turn = context.activeTurn;
      if (!turn) {
        return;
      }

      for (const toolState of turn.toolItems.values()) {
        if (toolState.completed) {
          continue;
        }
        toolState.completed = true;
        emit(
          baseEvent(context, {
            type: "item.completed",
            turnId: turn.id,
            itemId: toolState.itemId,
            ...(input.rawType ? { rawType: input.rawType } : {}),
            ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
            payload: {
              itemType: toolState.itemType,
              status: input.state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }

      cancelPendingUserInputs(context, {
        turnId: turn.id,
        ...(input.rawType ? { rawType: input.rawType } : {}),
        ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
      });

      if (input.state === "completed" && turn.interactionMode === "plan") {
        const planMarkdown = extractPiProposedPlanMarkdown(turn.assistantText);
        if (planMarkdown) {
          emit(
            baseEvent(context, {
              type: "turn.proposed.completed",
              turnId: turn.id,
              ...(input.rawType ? { rawType: input.rawType } : {}),
              ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
              payload: {
                planMarkdown,
              },
            }),
          );
        }
      }

      const turnSnapshot = resolveTurnSnapshot(context, turn.id);
      turnSnapshot.items = [...turn.items];
      context.replayTurns.push({
        prompt: turn.inputText,
        attachmentNames: [...turn.attachmentNames],
        ...(turn.visibleAssistantText.trim().length > 0
          ? { assistantResponse: turn.visibleAssistantText }
          : {}),
      });
      context.activeTurn = null;
      updateSession(context, {
        status: input.state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        ...(input.state === "failed"
          ? { lastError: input.errorMessage ?? "Pi turn failed." }
          : { lastError: undefined }),
      });
      emit(
        baseEvent(context, {
          type: "turn.completed",
          turnId: turn.id,
          ...(input.rawType ? { rawType: input.rawType } : {}),
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          payload: {
            state: input.state,
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
        }),
      );
      emit(
        baseEvent(context, {
          type: "session.state.changed",
          payload: {
            state: input.state === "failed" ? "error" : "ready",
          },
        }),
      );
    };

    const syncModelSelection = async (
      context: PiSessionContext,
      modelSelection:
        | Extract<ProviderSessionStartInput["modelSelection"], { provider: "pi" }>
        | Extract<ProviderSendTurnInput["modelSelection"], { provider: "pi" }>
        | undefined,
    ) => {
      if (!modelSelection) {
        return;
      }
      if (context.metadata.currentModelSlug === modelSelection.model) {
        return;
      }
      const model = resolveModelReference(context.metadata, modelSelection.model);
      if (!model) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "set_model",
          issue: `Pi model '${modelSelection.model}' must include a provider prefix such as 'openai/gpt-5.4'.`,
        });
      }
      const result = await context.client.request(
        "set_model",
        {
          provider: model.provider,
          modelId: model.modelId,
        },
        { timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS },
      );
      const normalizedModel = normalizePiModel(result);
      const availableModels =
        normalizedModel &&
        !context.metadata.availableModels.some((entry) => entry.slug === normalizedModel.slug)
          ? [normalizedModel, ...context.metadata.availableModels]
          : context.metadata.availableModels;
      context.metadata = {
        ...context.metadata,
        availableModels,
        currentModelSlug: normalizedModel?.slug ?? model.slug,
        ...(normalizedModel?.reasoning !== undefined
          ? { currentModelReasoning: normalizedModel.reasoning }
          : {}),
        ...(normalizedModel?.contextWindow !== undefined
          ? { currentContextWindow: normalizedModel.contextWindow }
          : {}),
      };
      updateSession(context, {
        model: normalizedModel?.slug ?? model.slug,
      });
      emitSessionConfigured(context, {
        rawType: "set_model",
        rawPayload: {
          provider: model.provider,
          modelId: model.modelId,
        },
        rawSource: "pi.rpc.command",
      });
    };

    const syncThoughtLevel = async (
      context: PiSessionContext,
      thoughtLevel: string | undefined,
    ) => {
      if (!thoughtLevel || context.metadata.currentThinkingLevel === thoughtLevel) {
        return;
      }
      await context.client.request(
        "set_thinking_level",
        { level: thoughtLevel },
        { timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS },
      );
      context.metadata = {
        ...context.metadata,
        currentThinkingLevel: thoughtLevel,
      };
      emitSessionConfigured(context, {
        rawType: "set_thinking_level",
        rawPayload: { level: thoughtLevel },
        rawSource: "pi.rpc.command",
      });
    };

    const emitPlanShimNotice = (context: PiSessionContext) => {
      if (context.emittedWarnings.has("plan")) {
        return;
      }
      context.emittedWarnings.add("plan");
      emit(
        baseEvent(context, {
          type: "config.warning",
          payload: {
            summary: "Pi plan mode is being emulated by Ace.",
            details:
              "Ace is constraining the Pi prompt and extracting proposed plans locally because Pi RPC does not expose a native plan mode.",
          },
        }),
      );
    };

    const emitApprovalModeWarning = (context: PiSessionContext) => {
      if (context.emittedWarnings.has("approval-required")) {
        return;
      }
      context.emittedWarnings.add("approval-required");
      emit(
        baseEvent(context, {
          type: "config.warning",
          payload: {
            summary: "Pi does not expose Codex-style approval mode over RPC.",
            details:
              "Ace continued with Pi's normal execution mode because Pi RPC does not emit tool permission requests.",
          },
        }),
      );
    };

    const emitProposedPlanDeltaFromAssistantText = (
      context: PiSessionContext,
      turn: PiTurnState,
      rawType: string,
      rawPayload: unknown,
    ) => {
      if (turn.interactionMode !== "plan") {
        return;
      }
      const planMarkdown = extractPiProposedPlanMarkdown(turn.assistantText);
      if (!planMarkdown || planMarkdown === turn.lastProposedPlanMarkdown) {
        return;
      }
      const previousPlanMarkdown = turn.lastProposedPlanMarkdown ?? "";
      turn.lastProposedPlanMarkdown = planMarkdown;
      if (previousPlanMarkdown.length > 0 && !planMarkdown.startsWith(previousPlanMarkdown)) {
        return;
      }
      const delta = planMarkdown.slice(previousPlanMarkdown.length);
      if (!delta) {
        return;
      }
      emit(
        baseEvent(context, {
          type: "turn.proposed.delta",
          turnId: turn.id,
          rawType,
          rawPayload,
          payload: {
            delta,
          },
        }),
      );
    };

    const emitUnsupportedModeWarnings = (
      context: PiSessionContext,
      input: Pick<ProviderSessionStartInput, "interactionMode" | "runtimeMode">,
    ) => {
      if (input.interactionMode === "plan") {
        emitPlanShimNotice(context);
      }
      if (input.runtimeMode === "approval-required") {
        emitApprovalModeWarning(context);
      }
    };

    const buildPromptPayload = async (input: ProviderSendTurnInput) => {
      const images: Array<Record<string, unknown>> = [];
      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") {
          continue;
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = await readFile(attachmentPath);
        images.push({
          type: "image",
          mimeType: attachment.mimeType,
          data: Buffer.from(bytes).toString("base64"),
        });
      }
      const message = promptMessage(input);
      return images.length > 0 ? { message, images } : { message };
    };

    const handleExtensionUiRequest = (
      context: PiSessionContext,
      event: Record<string, unknown>,
    ) => {
      const method = asString(event.method);
      const rpcRequestId = asString(event.id);
      if (!method || !rpcRequestId) {
        return;
      }

      if (method === "notify") {
        const message = asString(event.message);
        const notifyType = asString(event.notifyType);
        if (!message) {
          return;
        }
        emit(
          baseEvent(context, {
            type: notifyType === "error" ? "runtime.error" : "runtime.warning",
            rawType: "extension_ui_request",
            rawPayload: event,
            payload: notifyType === "error" ? { class: "provider_error", message } : { message },
          }),
        );
        return;
      }

      if (method !== "confirm" && method !== "select") {
        context.client.notify("extension_ui_response", {
          id: rpcRequestId,
          cancelled: true,
        });
        emit(
          baseEvent(context, {
            type: "runtime.warning",
            rawType: "extension_ui_request",
            rawPayload: event,
            payload: {
              message: `Pi requested unsupported '${method}' UI input; Ace cancelled it automatically.`,
            },
          }),
        );
        return;
      }

      const requestId = ApprovalRequestId.makeUnsafe(`pi-ui:${randomUUID()}`);
      const title = asString(event.title) ?? "Input requested";
      const questions =
        method === "confirm"
          ? buildUserInputQuestionsForConfirm(title, asString(event.message))
          : buildUserInputQuestionsForSelect(
              title,
              asArray(event.options).flatMap((option) =>
                typeof option === "string" && option.trim().length > 0 ? [option.trim()] : [],
              ),
            );
      if (questions[0]?.options.length === 0) {
        context.client.notify("extension_ui_response", {
          id: rpcRequestId,
          cancelled: true,
        });
        emit(
          baseEvent(context, {
            type: "runtime.warning",
            rawType: "extension_ui_request",
            rawPayload: event,
            payload: {
              message: `Pi requested '${method}' UI input without valid options; Ace cancelled it automatically.`,
            },
          }),
        );
        return;
      }

      context.pendingUserInputs.set(requestId, {
        requestId,
        rpcRequestId,
        method,
        questions,
        ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
      });
      emit(
        baseEvent(context, {
          type: "user-input.requested",
          ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
          requestId,
          rawType: "extension_ui_request",
          rawPayload: event,
          payload: { questions },
        }),
      );
      appendTurnItem(context, context.activeTurn?.id, {
        id: String(requestId),
        kind: "user_input",
        questions,
        status: "pending",
      });
    };

    const handleEvent = (context: PiSessionContext, event: PiRpcEvent) => {
      const turn = context.activeTurn;
      switch (event.type) {
        case "message_start":
        case "message_end": {
          if (!turn) {
            return;
          }
          const errorMessage = readPiAssistantErrorMessage(event.message);
          if (errorMessage) {
            turn.stopReason = "error";
            turn.errorMessage = errorMessage;
          }
          return;
        }
        case "message_update": {
          const deltaEvent = asObject(event.assistantMessageEvent);
          const deltaType = asString(deltaEvent?.type);
          if (!turn || !deltaType) {
            return;
          }
          if (deltaType === "text_delta") {
            const delta = asString(deltaEvent?.delta);
            if (!delta) {
              return;
            }
            turn.assistantText += delta;
            const nextVisibleAssistantText =
              turn.interactionMode === "plan"
                ? stripPiProposedPlanBlock(turn.assistantText)
                : turn.assistantText;
            const visibleDelta = nextVisibleAssistantText.startsWith(turn.visibleAssistantText)
              ? nextVisibleAssistantText.slice(turn.visibleAssistantText.length)
              : nextVisibleAssistantText;
            turn.visibleAssistantText = nextVisibleAssistantText;
            if (visibleDelta) {
              emit(
                baseEvent(context, {
                  type: "content.delta",
                  turnId: turn.id,
                  rawType: event.type,
                  rawPayload: event,
                  payload: {
                    streamKind: "assistant_text",
                    delta: visibleDelta,
                  },
                }),
              );
              appendTurnItem(context, turn.id, {
                kind: "assistant_text",
                text: visibleDelta,
              });
            }
            emitProposedPlanDeltaFromAssistantText(context, turn, event.type, event);
            return;
          }
          if (deltaType === "thinking_delta") {
            const delta = asString(deltaEvent?.delta);
            if (!delta) {
              return;
            }
            turn.reasoningText += delta;
            emit(
              baseEvent(context, {
                type: "content.delta",
                turnId: turn.id,
                rawType: event.type,
                rawPayload: event,
                payload: {
                  streamKind: "reasoning_text",
                  delta,
                },
              }),
            );
            appendTurnItem(context, turn.id, {
              kind: "reasoning_text",
              text: delta,
            });
            return;
          }
          if (deltaType === "done" || deltaType === "error") {
            turn.stopReason = asString(deltaEvent?.reason) ?? turn.stopReason;
            turn.errorMessage =
              asString(deltaEvent?.message) ??
              asString(asObject(event.message)?.stopReason) ??
              turn.errorMessage;
          }
          return;
        }
        case "tool_execution_start": {
          const toolCallId = asString(event.toolCallId);
          if (!turn || !toolCallId) {
            return;
          }
          if (turn.interactionMode === "plan" && !turn.planToolWarningEmitted) {
            turn.planToolWarningEmitted = true;
            emit(
              baseEvent(context, {
                type: "runtime.warning",
                turnId: turn.id,
                rawType: event.type,
                rawPayload: event,
                payload: {
                  message:
                    "Pi started a tool while Ace-managed plan mode was active. Plan-only behavior is best-effort for this provider.",
                },
              }),
            );
          }
          ensureToolItem(context, turn, toolCallId, {
            toolName: asString(event.toolName),
            args: event.args,
            rawType: event.type,
            rawPayload: event,
          });
          return;
        }
        case "tool_execution_update": {
          const toolCallId = asString(event.toolCallId);
          if (!turn || !toolCallId) {
            return;
          }
          const toolState = ensureToolItem(context, turn, toolCallId, {
            toolName: asString(event.toolName),
            args: event.args,
            rawType: event.type,
            rawPayload: event,
          });
          emitToolOutputDelta(
            context,
            turn,
            toolState,
            extractContentText(asObject(event.partialResult)?.content),
            event.type,
            event,
          );
          return;
        }
        case "tool_execution_end": {
          const toolCallId = asString(event.toolCallId);
          if (!turn || !toolCallId) {
            return;
          }
          const toolState = ensureToolItem(context, turn, toolCallId, {
            toolName: asString(event.toolName),
            rawType: event.type,
            rawPayload: event,
          });
          emitToolOutputDelta(
            context,
            turn,
            toolState,
            extractContentText(asObject(event.result)?.content),
            event.type,
            event,
          );
          if (!toolState.completed) {
            toolState.completed = true;
            emit(
              baseEvent(context, {
                type: "item.completed",
                turnId: turn.id,
                itemId: toolState.itemId,
                rawType: event.type,
                rawPayload: event,
                payload: {
                  itemType: toolState.itemType,
                  status: event.isError === true ? "failed" : "completed",
                },
              }),
            );
            appendTurnItem(context, turn.id, {
              id: String(toolState.itemId),
              itemType: toolState.itemType,
              status: event.isError === true ? "failed" : "completed",
            });
          }
          return;
        }
        case "turn_end": {
          if (!turn) {
            return;
          }
          const message = asObject(event.message);
          turn.stopReason = asString(message?.stopReason) ?? turn.stopReason;
          turn.errorMessage = readPiAssistantErrorMessage(event.message) ?? turn.errorMessage;
          return;
        }
        case "agent_end": {
          if (!turn) {
            return;
          }
          void emitUsageSnapshot(context);
          const stopReason =
            turn.stopReason ?? asString(asObject(event.message)?.stopReason) ?? null;
          if (stopReason === "aborted" || turn.interruptedRequested) {
            completeTurn(context, {
              state: "interrupted",
              stopReason,
              rawType: event.type,
              rawPayload: event,
            });
            return;
          }
          if (stopReason === "error" || turn.errorMessage) {
            completeTurn(context, {
              state: "failed",
              stopReason,
              errorMessage: turn.errorMessage ?? "Pi turn failed.",
              rawType: event.type,
              rawPayload: event,
            });
            return;
          }
          completeTurn(context, {
            state: "completed",
            stopReason,
            rawType: event.type,
            rawPayload: event,
          });
          return;
        }
        case "extension_error": {
          emit(
            baseEvent(context, {
              type: "runtime.error",
              rawType: event.type,
              rawPayload: event,
              payload: {
                class: "provider_error",
                message:
                  asString(event.errorMessage) ?? asString(event.message) ?? "Pi extension error.",
              },
            }),
          );
          return;
        }
        case "extension_ui_request": {
          handleExtensionUiRequest(context, event);
          return;
        }
        default:
          return;
      }
    };

    const startSessionContext = async (
      input: ProviderSessionStartInput,
    ): Promise<PiSessionContext> => {
      const settings = await runPromise(
        settingsService.getSettings.pipe(Effect.map((state) => state.providers.pi)),
      );
      const cwd = input.cwd ?? serverConfig.cwd;
      const args = ["--mode", "rpc", "--no-session"];
      const client = startPiRpcClient({
        binaryPath: settings.binaryPath,
        args,
        cwd,
      });

      const stateResult = await client.request("get_state", undefined, {
        timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS,
      });
      const [modelsResult, commandsResult] = await Promise.all([
        client
          .request("get_available_models", undefined, { timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS })
          .catch(() => null),
        client
          .request("get_commands", undefined, { timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS })
          .catch(() => null),
      ]);
      const stateRecord = asObject(stateResult);
      const sessionId = asString(stateRecord?.sessionId) ?? randomUUID();
      const createdAt = isoNow();
      const metadata = createSessionMetadata({
        state: stateRecord,
        models: asObject(modelsResult)?.models,
        commands: asObject(commandsResult)?.commands,
      });
      const context: PiSessionContext = {
        threadId: input.threadId,
        client,
        session: {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(cwd ? { cwd } : {}),
          model: metadata.currentModelSlug ?? DEFAULT_MODEL_BY_PROVIDER.pi,
          threadId: input.threadId,
          resumeCursor: { sessionId },
          createdAt,
          updatedAt: createdAt,
        },
        metadata,
        turns: [],
        replayTurns: cloneReplayTurns(input.replayTurns),
        pendingUserInputs: new Map(),
        emittedWarnings: new Set(),
        activeTurn: null,
        pendingBootstrapReset: (input.replayTurns?.length ?? 0) > 0,
        closed: false,
        stopRequested: false,
      };

      if (input.threadTitle) {
        try {
          await client.request(
            "set_session_name",
            { name: input.threadTitle },
            { timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS },
          );
        } catch (cause) {
          emit(
            baseEvent(context, {
              type: "runtime.warning",
              rawType: "set_session_name",
              rawPayload: { name: input.threadTitle },
              rawSource: "pi.rpc.command",
              payload: {
                message: toMessage(cause, "Unable to set the Pi session title."),
              },
            }),
          );
        }
      }

      client.setEventHandler((event) => handleEvent(context, event));
      client.setCloseHandler((close) => {
        context.closed = true;
        cancelPendingUserInputs(context, {
          notifyProvider: false,
          rawType: "session_closed",
          rawPayload: close,
          rawSource: "pi.rpc.command",
        });
        if (context.activeTurn) {
          completeTurn(context, {
            state: context.activeTurn.interruptedRequested ? "interrupted" : "failed",
            ...(context.activeTurn.interruptedRequested
              ? { stopReason: "aborted" }
              : {
                  errorMessage: `Pi RPC exited (code=${close.code ?? "null"}, signal=${close.signal ?? "null"}).`,
                }),
            rawType: "session_closed",
            rawPayload: close,
          });
        }
        if (context.stopRequested) {
          emit(
            baseEvent(context, {
              type: "session.exited",
              payload: {
                exitKind: "graceful",
                reason: "Pi session closed.",
              },
            }),
          );
          return;
        }
        updateSession(context, {
          status: "error",
          activeTurnId: undefined,
          lastError: `Pi RPC exited (code=${close.code ?? "null"}, signal=${close.signal ?? "null"}).`,
        });
        emit(
          baseEvent(context, {
            type: "session.state.changed",
            payload: {
              state: "error",
            },
          }),
        );
        emit(
          baseEvent(context, {
            type: "session.exited",
            payload: {
              exitKind: "error",
              reason: `Pi RPC exited (code=${close.code ?? "null"}, signal=${close.signal ?? "null"}).`,
              recoverable: true,
            },
          }),
        );
        emit(
          baseEvent(context, {
            type: "runtime.error",
            payload: {
              class: "transport_error",
              message: `Pi RPC exited unexpectedly (code=${close.code ?? "null"}, signal=${close.signal ?? "null"}).`,
            },
          }),
        );
      });
      client.setProtocolErrorHandler((error) => {
        emit(
          baseEvent(context, {
            type: "runtime.error",
            payload: {
              class: "transport_error",
              message: error.message,
            },
          }),
        );
      });

      sessions.set(input.threadId, context);
      emit(
        baseEvent(context, {
          type: "session.configured",
          rawType: "get_state",
          rawPayload: stateResult,
          rawSource: "pi.rpc.command",
          payload: {
            config: configSnapshot(context),
          },
        }),
      );
      if (modelsResult === null) {
        emit(
          baseEvent(context, {
            type: "runtime.warning",
            rawType: "get_available_models",
            rawSource: "pi.rpc.command",
            payload: {
              message:
                "Pi model discovery failed; Ace continued with the current Pi session state.",
            },
          }),
        );
      }
      if (commandsResult === null) {
        emit(
          baseEvent(context, {
            type: "runtime.warning",
            rawType: "get_commands",
            rawSource: "pi.rpc.command",
            payload: {
              message: "Pi command discovery failed; Ace continued with fallback slash commands.",
            },
          }),
        );
      }
      emit(
        baseEvent(context, {
          type: "session.started",
          payload: {
            resume: context.session.resumeCursor,
            processPid: client.child.pid ?? undefined,
          },
        }),
      );
      emit(
        baseEvent(context, {
          type: "session.state.changed",
          payload: {
            state: "ready",
            processPid: client.child.pid ?? undefined,
          },
        }),
      );
      emit(
        baseEvent(context, {
          type: "thread.started",
          payload: {
            providerThreadId: sessionId,
          },
        }),
      );
      if (input.threadTitle) {
        emit(
          baseEvent(context, {
            type: "thread.metadata.updated",
            rawType: "set_session_name",
            rawPayload: { name: input.threadTitle },
            rawSource: "pi.rpc.command",
            payload: {
              name: input.threadTitle,
              metadata: {},
            },
          }),
        );
      }

      await syncModelSelection(
        context,
        input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined,
      );
      await syncThoughtLevel(context, requestedPiThoughtLevel(input.modelSelection));
      emitUnsupportedModeWarnings(context, input);
      return context;
    };

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected Pi model selection, received '${input.modelSelection.provider}'.`,
            });
          }
          const existing = sessions.get(input.threadId);
          if (existing && !existing.closed) {
            existing.session = {
              ...existing.session,
              runtimeMode: input.runtimeMode,
              updatedAt: isoNow(),
            };
            await syncModelSelection(
              existing,
              input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined,
            );
            await syncThoughtLevel(existing, requestedPiThoughtLevel(input.modelSelection));
            emitUnsupportedModeWarnings(existing, input);
            return existing.session;
          }
          return (await startSessionContext(input)).session;
        },
        catch: (cause) =>
          isProviderAdapterValidationError(cause) || isProviderAdapterRequestError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "startSession",
                detail: toMessage(cause, "Pi session start failed"),
                cause,
              }),
      });

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(input.threadId);
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
              issue: `Expected Pi model selection, received '${input.modelSelection.provider}'.`,
            });
          }
          if (context.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Pi session is already running turn '${context.activeTurn.id}'.`,
            });
          }

          const turnId = TurnId.makeUnsafe(`pi-turn:${randomUUID()}`);
          context.activeTurn = {
            id: turnId,
            inputText: input.input ?? "",
            attachmentNames: (input.attachments ?? []).map((attachment) => attachment.name),
            interactionMode: input.interactionMode,
            assistantText: "",
            visibleAssistantText: "",
            reasoningText: "",
            items: [],
            toolItems: new Map(),
            planToolWarningEmitted: false,
            interruptedRequested: false,
            startedAtMs: Date.now(),
          };

          await syncModelSelection(
            context,
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined,
          );
          await syncThoughtLevel(context, requestedPiThoughtLevel(input.modelSelection));
          emitUnsupportedModeWarnings(context, {
            interactionMode: input.interactionMode,
            runtimeMode: context.session.runtimeMode,
          });

          const promptInput = context.pendingBootstrapReset
            ? {
                ...input,
                input: buildBootstrapPromptFromReplayTurns(
                  context.replayTurns,
                  input.input ?? "Continue from the saved transcript.",
                  BOOTSTRAP_MAX_CHARS,
                ).text,
              }
            : input;
          const effectivePromptInput =
            promptInput.interactionMode === "plan"
              ? {
                  ...promptInput,
                  input: wrapPiPlanPrompt(promptMessage(promptInput)),
                }
              : promptInput;
          const promptPayload = await buildPromptPayload(effectivePromptInput);

          await context.client.request("prompt", promptPayload, {
            timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS,
          });
          context.pendingBootstrapReset = false;
          updateSession(context, {
            status: "running",
            activeTurnId: turnId,
            ...(context.metadata.currentModelSlug
              ? { model: context.metadata.currentModelSlug }
              : {}),
          });
          emit(
            baseEvent(context, {
              type: "turn.started",
              turnId,
              rawType: "prompt",
              rawPayload: promptPayload,
              rawSource: "pi.rpc.command",
              payload: context.session.model ? { model: context.session.model } : {},
            }),
          );
          emit(
            baseEvent(context, {
              type: "session.state.changed",
              payload: {
                state: "running",
              },
            }),
          );

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.session.resumeCursor,
          } satisfies ProviderTurnStartResult;
        },
        catch: (cause) => {
          const context = sessions.get(input.threadId);
          if (context?.activeTurn) {
            context.activeTurn = null;
            updateSession(context, {
              status: "ready",
              activeTurnId: undefined,
            });
          }
          return isProviderAdapterValidationError(cause) ||
            isProviderAdapterRequestError(cause) ||
            isProviderAdapterSessionNotFoundError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: toMessage(cause, "Pi sendTurn failed"),
                cause,
              });
        },
      });

    const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(input.threadId);
          if (!context) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          if (!context.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "steer",
              detail: "Pi steer requires an active turn.",
            });
          }
          if (input.modelSelection?.provider && input.modelSelection.provider !== PROVIDER) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "steerTurn",
              issue: `Expected Pi model selection, received '${input.modelSelection.provider}'.`,
            });
          }
          if (
            input.modelSelection?.provider === PROVIDER &&
            input.modelSelection.model !== context.metadata.currentModelSlug
          ) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "steerTurn",
              issue: "Pi does not support model switching while a turn is already streaming.",
            });
          }
          if (
            input.modelSelection?.provider === PROVIDER &&
            requestedPiThoughtLevel(input.modelSelection) !== undefined &&
            requestedPiThoughtLevel(input.modelSelection) !== context.metadata.currentThinkingLevel
          ) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "steerTurn",
              issue:
                "Pi does not support thinking-level changes while a turn is already streaming.",
            });
          }
          const promptPayload = await buildPromptPayload(input);
          await context.client.request(
            "prompt",
            {
              ...promptPayload,
              streamingBehavior: "steer",
            },
            { timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS },
          );
          return {
            threadId: input.threadId,
            turnId: context.activeTurn.id,
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
                method: "steer",
                detail: toMessage(cause, "Pi steer failed"),
                cause,
              }),
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(threadId);
          if (!context) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          if (!context.activeTurn || (turnId && context.activeTurn.id !== turnId)) {
            return;
          }
          context.activeTurn.interruptedRequested = true;
          await context.client.request("abort", undefined, {
            timeoutMs: PI_RPC_CONTROL_TIMEOUT_MS,
          });
        },
        catch: (cause) =>
          isProviderAdapterSessionNotFoundError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "abort",
                detail: toMessage(cause, "Pi interrupt failed"),
                cause,
              }),
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Pi does not expose native approval requests over RPC.",
        }),
      );

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: async () => {
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
              method: "extension_ui_response",
              detail: `Unknown Pi user-input request '${requestId}'.`,
            });
          }
          const normalizedAnswers = Object.fromEntries(
            Object.entries(answers).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value]] : [],
            ),
          );
          const answerValue = normalizedAnswers[pending.questions[0]?.id ?? ""];
          if (pending.method === "confirm") {
            const confirmed = answerValue === "Confirm";
            context.client.notify("extension_ui_response", {
              id: pending.rpcRequestId,
              confirmed,
            });
          } else {
            const value = typeof answerValue === "string" ? answerValue : undefined;
            if (!value) {
              context.client.notify("extension_ui_response", {
                id: pending.rpcRequestId,
                cancelled: true,
              });
            } else {
              context.client.notify("extension_ui_response", {
                id: pending.rpcRequestId,
                value,
              });
            }
          }
          context.pendingUserInputs.delete(requestId);
          emitUserInputResolved(context, pending, normalizedAnswers, {
            rawType: "extension_ui_response",
            rawPayload: normalizedAnswers,
            rawSource: "pi.rpc.command",
          });
        },
        catch: (cause) =>
          isProviderAdapterSessionNotFoundError(cause) || isProviderAdapterRequestError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: toMessage(cause, "Pi respondToUserInput failed"),
                cause,
              }),
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(threadId);
          if (!context) {
            return;
          }
          context.stopRequested = true;
          cancelPendingUserInputs(context, { notifyProvider: false });
          sessions.delete(threadId);
          await context.client.close();
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "stopSession",
            detail: toMessage(cause, "Pi stopSession failed"),
            cause,
          }),
      });

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map((context) => context.session));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
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

    const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
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
            detail: "Pi cannot roll back while a turn is still running.",
          });
        }

        const nextLength = Math.max(0, context.turns.length - numTurns);
        const trimmedTurns = context.turns.slice(0, nextLength).map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        }));
        const trimmedReplayTurns = context.replayTurns.slice(0, nextLength).map((turn) =>
          turn.assistantResponse !== undefined
            ? {
                prompt: turn.prompt,
                attachmentNames: [...turn.attachmentNames],
                assistantResponse: turn.assistantResponse,
              }
            : {
                prompt: turn.prompt,
                attachmentNames: [...turn.attachmentNames],
              },
        );

        yield* stopSession(threadId);
        yield* startSession({
          provider: PROVIDER,
          threadId,
          runtimeMode: context.session.runtimeMode,
          ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
          ...(context.session.model
            ? {
                modelSelection: {
                  provider: PROVIDER,
                  model: context.session.model,
                  ...(normalizePiThoughtLevel(context.metadata.currentThinkingLevel)
                    ? {
                        options: {
                          thoughtLevel: normalizePiThoughtLevel(
                            context.metadata.currentThinkingLevel,
                          )!,
                        },
                      }
                    : {}),
                } as const,
              }
            : {}),
        });

        const restarted = sessions.get(threadId);
        if (!restarted) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "Pi rollback failed to recreate the session.",
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

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.promise(() =>
        Promise.all(
          Array.from(sessions.entries()).map(async ([threadId]) => {
            await runPromise(stopSession(threadId));
          }),
        ).then(() => undefined),
      );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        sessionModelOptionsSwitch: "in-session",
        liveTurnDiffMode: "workspace",
        reviewChangesMode: "git",
        reviewSurface: "git-worktree",
        approvalRequestsMode: "none",
        turnSteeringMode: "native",
        transcriptAuthority: "local",
        historyAuthority: "local-server-session",
        sessionResumeMode: "local-replay",
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromPubSub(eventsPubSub);
      },
    } satisfies PiAdapterShape;
  }),
);
