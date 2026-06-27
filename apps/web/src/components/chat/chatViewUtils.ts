import {
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type KeybindingCommand,
  type MessageId,
  type OrchestrationMessage,
  type ProjectId,
  type ProjectScript,
  type ProviderKind,
  type TurnId,
} from "@ace/contracts";
import { truncate } from "@ace/shared/String";
import {
  resolveBrowserInstanceScopeId,
  resolveBrowserThreadIdFromScopeId,
  type BrowserPanelPlacement,
} from "~/lib/browser/scope";
import { type BrowserSessionStorage } from "~/lib/browser/session";
import { setBrowserSession } from "~/lib/browser/sessionStore";
import { type BrowserDesignRequestSubmission } from "~/lib/browser/types";
import {
  resolveHandoffLineage,
  resolveThreadLineageSourceThreadId,
  type HandoffLineageResult,
} from "~/lib/chat/handoff";
import { getChatMessageFullText } from "~/lib/chat/messageText";
import { type SourceTimelineRowsInput } from "~/lib/chat/sourceTimelineRows";
import {
  primeLiveTimelineRow,
  removeLiveTimelineRow,
  type TimelineSourceRow,
} from "~/lib/chat/timelineModelStore";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { type AppState } from "../../store";
import { type ChatMessage, type QueuedComposerImageAttachment, type Thread } from "../../types";
import { toastManager } from "../ui/toast";

const RESIZABLE_PANEL_WIDTH_CSS_VAR = "--ace-resizable-panel-width";
const RESIZABLE_PANEL_HEIGHT_CSS_VAR = "--ace-resizable-panel-height";

export function isAbsoluteFilesystemPath(path: string): boolean {
  return /^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(path);
}

export function eventTargetIsInsideElement(event: Event, element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  return event.composedPath().includes(element);
}

export function eventTargetIsInsideSelector(event: Event, selector: string): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(selector) !== null;
}

export function applyResizablePanelWidth(element: HTMLElement | null, width: number): void {
  if (!element) {
    return;
  }
  const widthPx = `${Math.round(width)}px`;
  element.style.setProperty(RESIZABLE_PANEL_WIDTH_CSS_VAR, widthPx);
  element.style.setProperty("width", `var(${RESIZABLE_PANEL_WIDTH_CSS_VAR})`);
  element.style.setProperty("flex-basis", `var(${RESIZABLE_PANEL_WIDTH_CSS_VAR})`);
  element.style.setProperty("min-width", `var(${RESIZABLE_PANEL_WIDTH_CSS_VAR})`);
}

export function clearResizablePanelWidth(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  element.style.removeProperty("width");
  element.style.removeProperty("flex-basis");
  element.style.removeProperty("min-width");
  element.style.removeProperty(RESIZABLE_PANEL_WIDTH_CSS_VAR);
}

export function applyResizablePanelHeight(element: HTMLElement | null, height: number): void {
  if (!element) {
    return;
  }
  element.style.setProperty(RESIZABLE_PANEL_HEIGHT_CSS_VAR, `${Math.round(height)}px`);
  element.style.setProperty("height", `var(${RESIZABLE_PANEL_HEIGHT_CSS_VAR})`);
}

export function clearResizablePanelHeight(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  element.style.removeProperty("height");
  element.style.removeProperty(RESIZABLE_PANEL_HEIGHT_CSS_VAR);
}

interface OptimisticInactiveTurnState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly requestedAt: string;
}

export function optimisticInactiveTurnCoversLiveTurn(input: {
  readonly state: OptimisticInactiveTurnState | null;
  readonly thread: Thread | undefined;
  readonly latestTurn: Thread["latestTurn"] | null;
  readonly rawLiveTurnInProgress: boolean;
}): boolean {
  if (!input.rawLiveTurnInProgress || !input.state || input.thread?.id !== input.state.threadId) {
    return false;
  }
  const activeSessionTurnId = input.thread.session?.activeTurnId ?? null;
  if (activeSessionTurnId !== null) {
    return activeSessionTurnId === input.state.turnId;
  }
  const latestTurn = input.latestTurn;
  return (
    latestTurn !== null &&
    latestTurn.state === "running" &&
    latestTurn.completedAt === null &&
    latestTurn.turnId === input.state.turnId
  );
}

type QueuedComposerMessage = Thread["queuedComposerMessages"][number];

function queuedComposerMessageOrderMatches(
  left: readonly QueuedComposerMessage[],
  right: readonly QueuedComposerMessage[],
): boolean {
  return (
    left.length === right.length && left.every((message, index) => message.id === right[index]?.id)
  );
}

function queuedSteerRequestsMatch(
  left: Thread["queuedSteerRequest"],
  right: Thread["queuedSteerRequest"],
): boolean {
  return (
    left?.messageId === right?.messageId &&
    left?.baselineWorkLogEntryCount === right?.baselineWorkLogEntryCount &&
    left?.interruptRequested === right?.interruptRequested
  );
}

interface QueuedComposerState {
  readonly threadId: ThreadId;
  readonly messages: readonly QueuedComposerMessage[];
  readonly steerRequest: Thread["queuedSteerRequest"];
}

export function queuedComposerStateMatches(
  state: QueuedComposerState,
  messages: readonly QueuedComposerMessage[],
  steerRequest: Thread["queuedSteerRequest"],
): boolean {
  return (
    queuedComposerMessageOrderMatches(state.messages, messages) &&
    queuedSteerRequestsMatch(state.steerRequest, steerRequest)
  );
}

export function refreshProviderStatus(): void {
  void readNativeApi()
    ?.server.refreshProviders()
    .catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Provider refresh failed",
        description: error instanceof Error ? error.message : "Unable to refresh provider status.",
      });
    });
}

export function toQueuedComposerCommandMessage(message: QueuedComposerMessage) {
  return {
    id: message.id,
    prompt: message.prompt,
    images: message.images.map((image: QueuedComposerImageAttachment) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.dataUrl,
    })),
    terminalContexts: message.terminalContexts.map((context) => ({ ...context })),
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
  };
}

export function onBrowserSessionChange(
  browserInstanceId: string,
  session: BrowserSessionStorage,
): void {
  setBrowserSession(browserInstanceId, session);
}

export async function persistProjectScripts(input: {
  projectId: ProjectId;
  projectCwd: string;
  previousScripts: ProjectScript[];
  nextScripts: ProjectScript[];
  keybinding?: string | null;
  keybindingCommand: KeybindingCommand;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) return;

  await api.orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId: input.projectId,
    scripts: input.nextScripts,
  });

  const keybindingRule = decodeProjectScriptKeybindingRule({
    keybinding: input.keybinding,
    command: input.keybindingCommand,
  });

  if (keybindingRule) {
    await api.server.upsertKeybinding(keybindingRule);
  }
}

interface ComposerDispatchFailureContext {
  provider: ProviderKind;
  model: string | null;
  visiblePromptLength: number;
  outgoingPromptLength: number;
  imageCount: number;
  imageBytes: number;
  terminalContextCount: number;
  terminalContextChars: number;
}

export function formatComposerDispatchFailureMessage(
  error: unknown,
  context: ComposerDispatchFailureContext,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Invalid string length") {
    const providerLabel = PROVIDER_DISPLAY_NAMES[context.provider] ?? context.provider;
    const modelLabel = context.model?.trim() || "default";
    return [
      "Failed to send because Ace hit a JavaScript string-size limit while preparing the turn.",
      `Provider: ${providerLabel}; model: ${modelLabel}.`,
      `Payload sizes: visible prompt ${String(context.visiblePromptLength)} chars, outgoing prompt ${String(context.outgoingPromptLength)} chars, images ${String(context.imageCount)} (${String(context.imageBytes)} bytes), terminal context ${String(context.terminalContextCount)} (${String(context.terminalContextChars)} chars).`,
    ].join(" ");
  }

  return error instanceof Error ? error.message : "Failed to send message.";
}

export function describeBrowserDesignCommentTarget(submission: BrowserDesignRequestSubmission): {
  targetLabel: string;
  detailLabel: string | null;
} {
  const targetLabel = submission.pagePath.trim() || submission.pageUrl.trim() || "Browser";
  const targetElement = submission.targetElement ?? submission.mainContainer;
  const textSnippet = targetElement?.textSnippet?.trim();
  const selector = targetElement?.selector?.trim();
  const tagName = targetElement?.tagName?.trim().toLowerCase();
  const detailLabel =
    textSnippet && textSnippet.length > 0
      ? truncate(textSnippet.replace(/\s+/g, " "), 90)
      : selector && selector.length > 0
        ? truncate(selector, 90)
        : tagName && tagName.length > 0
          ? tagName
          : null;
  return { targetLabel, detailLabel };
}

function handoffLineageResultsEqual(
  left: HandoffLineageResult | null,
  right: HandoffLineageResult | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  if (left.hasCycle !== right.hasCycle || left.missingThreadId !== right.missingThreadId) {
    return false;
  }
  if (left.threads.length !== right.threads.length) {
    return false;
  }
  for (let index = 0; index < left.threads.length; index += 1) {
    if (left.threads[index] !== right.threads[index]) {
      return false;
    }
  }
  return true;
}

export function createHandoffLineageSelector(sourceThreadId: ThreadId | null) {
  let previousResult: HandoffLineageResult | null = null;
  return (state: AppState): HandoffLineageResult | null => {
    if (!sourceThreadId) {
      previousResult = null;
      return null;
    }
    const nextResult = state.threadsById
      ? resolveHandoffLineageFromIndex(sourceThreadId, state.threadsById)
      : resolveHandoffLineage({
          sourceThreadId,
          threads: state.threads,
        });
    if (handoffLineageResultsEqual(previousResult, nextResult)) {
      return previousResult;
    }
    previousResult = nextResult;
    return nextResult;
  };
}

function resolveHandoffLineageFromIndex(
  sourceThreadId: ThreadId,
  threadsById: Readonly<Record<string, Thread>>,
): HandoffLineageResult {
  const lineageNewestFirst: Thread[] = [];
  const visited = new Set<string>();
  let currentThreadId: ThreadId | null = sourceThreadId;

  while (currentThreadId !== null) {
    const thread: Thread | undefined = threadsById[String(currentThreadId)];
    if (!thread) {
      return {
        threads: lineageNewestFirst.toReversed(),
        missingThreadId: currentThreadId,
        hasCycle: false,
      };
    }
    if (visited.has(thread.id)) {
      return {
        threads: lineageNewestFirst.toReversed(),
        missingThreadId: null,
        hasCycle: true,
      };
    }
    visited.add(thread.id);
    lineageNewestFirst.push(thread);
    currentThreadId = resolveThreadLineageSourceThreadId(thread);
  }

  return {
    threads: lineageNewestFirst.toReversed(),
    missingThreadId: null,
    hasCycle: false,
  };
}

export function resolveBrowserInstanceId(
  threadId: ThreadId,
  placement: BrowserPanelPlacement,
  windowInstanceId?: string | null,
): string {
  return resolveBrowserInstanceScopeId({ placement, threadId, windowInstanceId });
}

export function resolveBrowserThreadIdFromInstanceId(instanceId: string): ThreadId {
  const threadId = resolveBrowserThreadIdFromScopeId(instanceId);
  return ThreadId.makeUnsafe(threadId ?? instanceId);
}

const SOURCE_TIMELINE_ROWS_CONTENT_KEY_TAIL_ROWS = 32;

function hashSourceTimelineRowsContentPart(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export { hashSourceTimelineRowsContentPart };

export function buildSourceTimelineRowsContentKey(input: SourceTimelineRowsInput): string {
  const messageById = new Map(input.messages.map((message) => [String(message.id), message]));
  const activityById = new Map(input.activities.map((activity) => [String(activity.id), activity]));
  const proposedPlanById = new Map(input.proposedPlans.map((plan) => [String(plan.id), plan]));

  return input.rows
    .slice(-SOURCE_TIMELINE_ROWS_CONTENT_KEY_TAIL_ROWS)
    .map((row) => {
      const sourceRefKey = row.sourceRefs
        .map((sourceRef) => {
          const base = [
            sourceRef.kind,
            String(sourceRef.id),
            sourceRef.sourceIndex,
            sourceRef.sequence ?? "",
            sourceRef.turnId ?? "",
          ];
          if (sourceRef.kind === "message") {
            const message = messageById.get(String(sourceRef.id));
            return [
              ...base,
              message?.role ?? "",
              message?.streaming === true ? "streaming" : "settled",
              message?.updatedAt && message.streaming !== true ? message.updatedAt : "",
              hashSourceTimelineRowsContentPart(message?.text ?? ""),
              message?.attachments?.map((attachment) => String(attachment.id)).join(",") ?? "",
            ].join(":");
          }
          if (sourceRef.kind === "activity") {
            const activity = activityById.get(String(sourceRef.id));
            return [
              ...base,
              activity?.kind ?? "",
              activity?.tone ?? "",
              hashSourceTimelineRowsContentPart(activity?.summary ?? ""),
              hashSourceTimelineRowsContentPart(JSON.stringify(activity?.payload ?? null)),
            ].join(":");
          }
          const proposedPlan = proposedPlanById.get(String(sourceRef.id));
          return [
            ...base,
            proposedPlan?.implementedAt ?? "",
            hashSourceTimelineRowsContentPart(proposedPlan?.planMarkdown ?? ""),
          ].join(":");
        })
        .join("|");
      return [
        row.id,
        row.kind,
        row.startSourceIndex,
        row.endSourceIndexExclusive,
        row.turnId ?? "",
        input.activeTurnInProgress ? "active" : row.updatedAt,
        sourceRefKey,
      ].join(":");
    })
    .join("\0");
}

function toOptimisticOrchestrationMessage(message: ChatMessage): OrchestrationMessage {
  return {
    id: message.id,
    role: message.role,
    text: getChatMessageFullText(message),
    turnId: message.turnId ?? null,
    streaming: message.streaming,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    createdAt: message.createdAt,
    updatedAt: message.completedAt ?? message.createdAt,
  };
}

export function primeOptimisticUserTimelineRow(input: {
  readonly threadId: ThreadId;
  readonly message: ChatMessage;
}): void {
  const orchestrationMessage = toOptimisticOrchestrationMessage(input.message);
  primeLiveTimelineRow(
    {
      threadId: input.threadId,
      updatedAt: orchestrationMessage.updatedAt,
      entry: {
        kind: "message",
        id: String(orchestrationMessage.id),
        createdAt: orchestrationMessage.createdAt,
        turnId: orchestrationMessage.turnId,
        ...(orchestrationMessage.sequence !== undefined
          ? { sequence: orchestrationMessage.sequence }
          : {}),
      },
      message: orchestrationMessage,
    },
    { flush: "sync" },
  );
}

export function removeOptimisticUserTimelineRow(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}): void {
  removeLiveTimelineRow(
    {
      threadId: input.threadId,
      kind: "message",
      id: String(input.messageId),
    },
    { flush: "sync" },
  );
}

export function appendOptimisticUserMessagesToSourceTimeline(input: {
  readonly rows: ReadonlyArray<TimelineSourceRow>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly optimisticUserMessages: ReadonlyArray<ChatMessage>;
}): {
  readonly rows: ReadonlyArray<TimelineSourceRow>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
} {
  if (input.optimisticUserMessages.length === 0) {
    return { rows: input.rows, messages: input.messages };
  }

  const existingMessageIds = new Set(input.messages.map((message) => String(message.id)));
  const optimisticMessages: OrchestrationMessage[] = [];
  for (const message of input.optimisticUserMessages) {
    if (!existingMessageIds.has(String(message.id))) {
      optimisticMessages.push(toOptimisticOrchestrationMessage(message));
    }
  }
  if (optimisticMessages.length === 0) {
    return { rows: input.rows, messages: input.messages };
  }

  const nextRows = [...input.rows];
  let nextSourceIndex =
    nextRows.reduce((maxIndex, row) => Math.max(maxIndex, row.endSourceIndexExclusive), 0) || 0;
  for (const message of optimisticMessages) {
    const rowId = `message:${String(message.id)}`;
    nextRows.push({
      id: rowId,
      kind: "message",
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      contentVersion: [
        "optimistic",
        String(message.id),
        message.updatedAt,
        String(message.text.length),
      ].join(":"),
      startSourceIndex: nextSourceIndex,
      endSourceIndexExclusive: nextSourceIndex + 1,
      ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
      sourceRefs: [
        {
          kind: "message",
          id: String(message.id),
          createdAt: message.createdAt,
          sourceIndex: nextSourceIndex,
          ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
          ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
        },
      ],
    });
    nextSourceIndex += 1;
  }

  return {
    rows: nextRows,
    messages: [...input.messages, ...optimisticMessages],
  };
}

const BROWSER_BRIDGE_CONTROLLER_WAIT_MS = 5_000;
const BROWSER_BRIDGE_CONTROLLER_POLL_MS = 50;

export async function waitForBrowserBridgeController<TResult>(options: {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly readController: () => TResult | null;
}): Promise<TResult | null> {
  const deadline = Date.now() + options.timeoutMs;
  const poll = async (): Promise<TResult | null> => {
    const controller = options.readController();
    if (controller !== null) {
      return controller;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, options.pollMs);
    });
    return poll();
  };
  return poll();
}
