import {
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type ProjectId,
  ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationCheckpointSummary,
  type OrchestrationThread,
  type OrchestrationSessionStatus,
} from "@ace/contracts";
import * as Schema from "effect/Schema";
import { resolveModelSlugForProvider } from "@ace/shared/model";
import { create } from "zustand";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  derivePendingApprovals,
  derivePendingUserInputs,
} from "./session-logic";
import {
  appendCompactedThreadActivity,
  DEFAULT_MAX_THREAD_ACTIVITIES,
} from "@ace/shared/orchestrationThreadActivities";
import { compareSequenceThenCreatedAt } from "./lib/activityOrder";
import {
  appendChatMessageStreamingTextState,
  createChatMessageStreamingTextState,
  finalizeChatMessageText,
} from "./lib/chat/messageText";
import { primeHydratedThreadCache } from "./lib/threadHydrationCache";
import { resolveConnectionForThreadId } from "./lib/connectionRouting";
import { resolveServerUrl } from "./lib/utils";
import { type ChatMessage, type Project, type SidebarThreadSummary, type Thread } from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsById?: Record<string, Thread>;
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  dismissedThreadErrorKeysById: Record<string, string>;
  bootstrapComplete: boolean;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsById: {},
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  dismissedThreadErrorKeysById: {},
  bootstrapComplete: false,
};

function createInitialState(): AppState {
  return {
    projects: [],
    threads: [],
    threadsById: {},
    sidebarThreadsById: {},
    threadIdsByProjectId: {},
    dismissedThreadErrorKeysById: {},
    bootstrapComplete: false,
  };
}
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_PROPOSED_PLANS = 200;
const EMPTY_THREAD_IDS: ThreadId[] = [];
const threadLookupCache = new WeakMap<ReadonlyArray<Thread>, Map<ThreadId, Thread>>();
const LEAN_THREAD_ACTIVITY_KINDS = new Set<Thread["activities"][number]["kind"]>([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

// ── Pure helpers ──────────────────────────────────────────────────────

function getThreadLookup(threads: ReadonlyArray<Thread>): Map<ThreadId, Thread> {
  const cached = threadLookupCache.get(threads);
  if (cached) {
    return cached;
  }

  const lookup = new Map<ThreadId, Thread>();
  for (const thread of threads) {
    lookup.set(thread.id, thread);
  }
  threadLookupCache.set(threads, lookup);
  return lookup;
}

export function getThreadById(
  threads: ReadonlyArray<Thread>,
  threadId: ThreadId | null | undefined,
): Thread | undefined {
  if (!threadId) {
    return undefined;
  }
  return getThreadLookup(threads).get(threadId);
}

export function getThreadsByIds(
  threads: ReadonlyArray<Thread>,
  threadIds: readonly ThreadId[],
): Array<Thread | undefined> {
  if (threadIds.length === 0) {
    return [];
  }
  const lookup = getThreadLookup(threads);
  return threadIds.map((threadId) => lookup.get(threadId));
}

function buildThreadsById(threads: ReadonlyArray<Thread>): Record<string, Thread> {
  const threadsById: Record<string, Thread> = {};
  for (const thread of threads) {
    threadsById[thread.id] = thread;
  }
  return threadsById;
}

export function getThreadByIdFromState(
  state: Pick<AppState, "threads" | "threadsById">,
  threadId: ThreadId | null | undefined,
): Thread | undefined {
  if (!threadId) {
    return undefined;
  }
  return state.threadsById?.[threadId] ?? getThreadById(state.threads, threadId);
}

export function getThreadsByIdsFromState(
  state: Pick<AppState, "threads" | "threadsById">,
  threadIds: readonly ThreadId[],
): Array<Thread | undefined> {
  if (threadIds.length === 0) {
    return [];
  }
  if (!state.threadsById) {
    return getThreadsByIds(state.threads, threadIds);
  }
  return threadIds.map((threadId) => state.threadsById?.[threadId]);
}

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  const threadIndex = threads.findIndex((thread) => thread.id === threadId);
  if (threadIndex < 0) {
    return threads;
  }
  const thread = threads[threadIndex];
  if (!thread) {
    return threads;
  }
  const updatedThread = updater(thread);
  if (updatedThread === thread) {
    return threads;
  }
  const next = [...threads];
  next[threadIndex] = updatedThread;
  return next;
}

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

function normalizeModelSelection<T extends { provider: ProviderKind; model: string }>(
  selection: T,
): T {
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.provider, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): Thread["session"] {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    ...(session.capabilities ? { capabilities: session.capabilities } : {}),
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function resolveSessionVisibleError(
  session: OrchestrationSession | null | undefined,
): string | null {
  if (session?.status !== "error") {
    return null;
  }
  return session.lastError ?? null;
}

function resolveThreadErrorDismissalKey(thread: Pick<Thread, "error" | "session">): string | null {
  if (thread.session?.status === "error" && thread.session.lastError) {
    return `${thread.session.lastError}\u0000${thread.session.updatedAt}`;
  }
  if (!thread.error) {
    return null;
  }
  return thread.error;
}

function isThreadErrorDismissed(
  dismissedThreadErrorKeysById: Readonly<Record<string, string>>,
  threadId: ThreadId,
  thread: Pick<Thread, "error" | "session">,
): boolean {
  const dismissalKey = resolveThreadErrorDismissalKey(thread);
  return dismissalKey !== null && dismissedThreadErrorKeysById[threadId] === dismissalKey;
}

function suppressDismissedThreadError(
  thread: Thread,
  dismissedThreadErrorKeysById: Readonly<Record<string, string>>,
): Thread {
  if (!isThreadErrorDismissed(dismissedThreadErrorKeysById, thread.id, thread)) {
    return thread;
  }
  return {
    ...thread,
    error: null,
  };
}

function mapMessage(message: OrchestrationMessage, connectionUrl?: string): ChatMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id), connectionUrl),
  }));

  return {
    id: message.id,
    role: message.role,
    text: message.streaming ? "" : message.text,
    ...(message.streaming
      ? { streamingTextState: createChatMessageStreamingTextState(message.text) }
      : {}),
    turnId: message.turnId,
    createdAt: message.createdAt,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function mapQueuedComposerMessage(
  message: OrchestrationThread["queuedComposerMessages"][number],
): Thread["queuedComposerMessages"][number] {
  return {
    id: message.id,
    prompt: message.prompt,
    images: message.images.map((image) => ({
      type: "image",
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.dataUrl,
      previewUrl: image.dataUrl,
    })),
    terminalContexts: message.terminalContexts.map((context) => ({ ...context })),
    modelSelection: normalizeModelSelection(message.modelSelection),
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
  };
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): Thread["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapLatestProposedPlanSummary(
  summary: OrchestrationThread["latestProposedPlanSummary"],
): Thread["latestProposedPlanSummary"] {
  return summary ? { ...summary } : null;
}

function toLatestProposedPlanSummary(
  proposedPlan: Pick<
    Thread["proposedPlans"][number],
    "id" | "turnId" | "implementedAt" | "implementationThreadId" | "createdAt" | "updatedAt"
  >,
): Thread["latestProposedPlanSummary"] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function findLatestProposedPlanSummary(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
): Thread["latestProposedPlanSummary"] {
  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  return latestPlan ? toLatestProposedPlanSummary(latestPlan) : null;
}

function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    source: checkpoint.source,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    diff: checkpoint.diff,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function mergeThreadPreservingHydratedHistory(
  existingThread: Thread | undefined,
  incomingThread: Thread,
  preserveHydratedHistory = true,
): Thread {
  if (
    !preserveHydratedHistory ||
    !existingThread ||
    existingThread.historyLoaded === false ||
    incomingThread.historyLoaded
  ) {
    return existingThread && threadsRenderEquivalent(existingThread, incomingThread)
      ? existingThread
      : incomingThread;
  }
  const mergedThread = {
    ...incomingThread,
    messages: existingThread.messages,
    proposedPlans: existingThread.proposedPlans,
    latestProposedPlanSummary:
      existingThread.latestProposedPlanSummary ?? incomingThread.latestProposedPlanSummary,
    turnDiffSummaries: existingThread.turnDiffSummaries,
    activities: existingThread.activities,
    historyLoaded: true,
  };
  return threadsRenderEquivalent(existingThread, mergedThread) ? existingThread : mergedThread;
}

function modelSelectionsEqual(
  left: Thread["modelSelection"],
  right: Thread["modelSelection"],
): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function sessionsEqual(left: Thread["session"], right: Thread["session"]): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.provider === right.provider &&
    left.status === right.status &&
    left.orchestrationStatus === right.orchestrationStatus &&
    left.activeTurnId === right.activeTurnId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastError === right.lastError
  );
}

function latestTurnsEqual(left: Thread["latestTurn"], right: Thread["latestTurn"]): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.requestedAt === right.requestedAt &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.assistantMessageId === right.assistantMessageId &&
    left.sourceProposedPlan?.threadId === right.sourceProposedPlan?.threadId &&
    left.sourceProposedPlan?.planId === right.sourceProposedPlan?.planId
  );
}

function proposedPlanSummariesEqual(
  left: Thread["latestProposedPlanSummary"],
  right: Thread["latestProposedPlanSummary"],
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.implementedAt === right.implementedAt &&
    left.implementationThreadId === right.implementationThreadId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function handoffsEqual(left: Thread["handoff"], right: Thread["handoff"]): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.sourceThreadId === right.sourceThreadId &&
    left.fromProvider === right.fromProvider &&
    left.toProvider === right.toProvider &&
    left.mode === right.mode &&
    left.createdAt === right.createdAt
  );
}

function queuedSteerRequestsEqual(
  left: Thread["queuedSteerRequest"],
  right: Thread["queuedSteerRequest"],
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.messageId === right.messageId &&
    left.baselineWorkLogEntryCount === right.baselineWorkLogEntryCount &&
    left.interruptRequested === right.interruptRequested
  );
}

function queuedComposerMessagesEqual(
  left: Thread["queuedComposerMessages"],
  right: Thread["queuedComposerMessages"],
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftMessage = left[index];
    const rightMessage = right[index];
    if (!leftMessage || !rightMessage) {
      return false;
    }
    if (
      leftMessage.id !== rightMessage.id ||
      leftMessage.prompt !== rightMessage.prompt ||
      leftMessage.runtimeMode !== rightMessage.runtimeMode ||
      leftMessage.interactionMode !== rightMessage.interactionMode ||
      leftMessage.modelSelection.provider !== rightMessage.modelSelection.provider ||
      leftMessage.modelSelection.model !== rightMessage.modelSelection.model ||
      leftMessage.images.length !== rightMessage.images.length ||
      leftMessage.terminalContexts.length !== rightMessage.terminalContexts.length
    ) {
      return false;
    }
    for (let imageIndex = 0; imageIndex < leftMessage.images.length; imageIndex += 1) {
      const leftImage = leftMessage.images[imageIndex];
      const rightImage = rightMessage.images[imageIndex];
      if (
        !leftImage ||
        !rightImage ||
        leftImage.id !== rightImage.id ||
        leftImage.name !== rightImage.name ||
        leftImage.mimeType !== rightImage.mimeType ||
        leftImage.sizeBytes !== rightImage.sizeBytes ||
        leftImage.dataUrl !== rightImage.dataUrl
      ) {
        return false;
      }
    }
    for (
      let contextIndex = 0;
      contextIndex < leftMessage.terminalContexts.length;
      contextIndex += 1
    ) {
      const leftContext = leftMessage.terminalContexts[contextIndex];
      const rightContext = rightMessage.terminalContexts[contextIndex];
      if (
        !leftContext ||
        !rightContext ||
        leftContext.id !== rightContext.id ||
        leftContext.createdAt !== rightContext.createdAt ||
        leftContext.terminalId !== rightContext.terminalId ||
        leftContext.terminalLabel !== rightContext.terminalLabel ||
        leftContext.lineStart !== rightContext.lineStart ||
        leftContext.lineEnd !== rightContext.lineEnd ||
        leftContext.text !== rightContext.text
      ) {
        return false;
      }
    }
  }
  return true;
}

function threadsRenderEquivalent(left: Thread, right: Thread): boolean {
  return (
    left.id === right.id &&
    left.codexThreadId === right.codexThreadId &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    modelSelectionsEqual(left.modelSelection, right.modelSelection) &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    sessionsEqual(left.session, right.session) &&
    left.messages === right.messages &&
    left.proposedPlans === right.proposedPlans &&
    proposedPlanSummariesEqual(left.latestProposedPlanSummary, right.latestProposedPlanSummary) &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    left.pendingSourceProposedPlan?.threadId === right.pendingSourceProposedPlan?.threadId &&
    left.pendingSourceProposedPlan?.planId === right.pendingSourceProposedPlan?.planId &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    handoffsEqual(left.handoff, right.handoff) &&
    left.historyLoaded === right.historyLoaded &&
    queuedComposerMessagesEqual(left.queuedComposerMessages, right.queuedComposerMessages) &&
    queuedSteerRequestsEqual(left.queuedSteerRequest, right.queuedSteerRequest) &&
    left.turnDiffSummaries === right.turnDiffSummaries &&
    left.activities === right.activities
  );
}

export interface SnapshotSyncOptions {
  hydrateThreadId?: ThreadId | null;
  connectionUrl?: string;
}

function resolveThreadHistoryLoaded(threadId: ThreadId, options?: SnapshotSyncOptions): boolean {
  if (options === undefined || !Object.prototype.hasOwnProperty.call(options, "hydrateThreadId")) {
    return true;
  }
  return options.hydrateThreadId !== null && options.hydrateThreadId === threadId;
}

function mapThread(thread: OrchestrationThread, options?: SnapshotSyncOptions): Thread {
  const threadConnectionUrl = options?.connectionUrl ?? resolveConnectionForThreadId(thread.id);
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map((message) => mapMessage(message, threadConnectionUrl)),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    latestProposedPlanSummary: mapLatestProposedPlanSummary(thread.latestProposedPlanSummary),
    error: resolveSessionVisibleError(thread.session),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    ...(thread.handoff !== undefined ? { handoff: thread.handoff } : {}),
    historyLoaded: resolveThreadHistoryLoaded(thread.id, options),
    queuedComposerMessages: thread.queuedComposerMessages.map(mapQueuedComposerMessage),
    queuedSteerRequest: thread.queuedSteerRequest ? { ...thread.queuedSteerRequest } : null,
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
  };
}

function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return {
    id: project.id,
    name: project.title,
    cwd: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    icon: project.icon ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt ?? null,
    scripts: mapProjectScripts(project.scripts),
  };
}

function getLatestUserMessageAt(
  messages: ReadonlyArray<Thread["messages"][number]>,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

function buildSidebarThreadSummary(
  thread: Thread,
  dismissedThreadErrorKeysById: Readonly<Record<string, string>>,
): SidebarThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    ...(thread.handoff !== undefined ? { handoff: thread.handoff } : {}),
    latestUserMessageAt: getLatestUserMessageAt(thread.messages),
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
    isErrorDismissed: isThreadErrorDismissed(dismissedThreadErrorKeysById, thread.id, thread),
    hasActionableProposedPlan: hasActionableProposedPlan(
      thread.latestProposedPlanSummary ??
        findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
  };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.handoff?.sourceThreadId === right.handoff?.sourceThreadId &&
    left.handoff?.fromProvider === right.handoff?.fromProvider &&
    left.handoff?.toProvider === right.handoff?.toProvider &&
    left.handoff?.mode === right.handoff?.mode &&
    left.handoff?.createdAt === right.handoff?.createdAt &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.isErrorDismissed === right.isErrorDismissed &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function appendThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: [...existingThreadIds, threadId],
  };
}

function removeThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (!existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  const nextThreadIds = existingThreadIds.filter(
    (existingThreadId) => existingThreadId !== threadId,
  );
  if (nextThreadIds.length === existingThreadIds.length) {
    return threadIdsByProjectId;
  }
  if (nextThreadIds.length === 0) {
    const nextThreadIdsByProjectId = { ...threadIdsByProjectId };
    delete nextThreadIdsByProjectId[projectId];
    return nextThreadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: nextThreadIds,
  };
}

function buildThreadIdsByProjectId(threads: ReadonlyArray<Thread>): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
  dismissedThreadErrorKeysById: Readonly<Record<string, string>>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(thread, dismissedThreadErrorKeysById),
    ]),
  );
}

function buildSidebarThreadsByIdPreserving(
  threads: ReadonlyArray<Thread>,
  dismissedThreadErrorKeysById: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, SidebarThreadSummary>>,
): Record<string, SidebarThreadSummary> {
  let changed = Object.keys(previous).length !== threads.length;
  const next: Record<string, SidebarThreadSummary> = {};
  for (const thread of threads) {
    const nextSummary = buildSidebarThreadSummary(thread, dismissedThreadErrorKeysById);
    const previousSummary = previous[thread.id];
    if (sidebarThreadSummariesEqual(previousSummary, nextSummary)) {
      next[thread.id] = previousSummary;
      continue;
    }
    changed = true;
    next[thread.id] = nextSummary;
  }
  return changed ? next : (previous as Record<string, SidebarThreadSummary>);
}

function threadIdArraysEqual(left: readonly ThreadId[], right: readonly ThreadId[]): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

function buildThreadIdsByProjectIdPreserving(
  threads: ReadonlyArray<Thread>,
  previous: Readonly<Record<string, ThreadId[]>>,
): Record<string, ThreadId[]> {
  const next = buildThreadIdsByProjectId(threads);
  const previousProjectIds = Object.keys(previous);
  const nextProjectIds = Object.keys(next);
  if (previousProjectIds.length !== nextProjectIds.length) {
    return next;
  }
  for (const projectId of nextProjectIds) {
    const previousThreadIds = previous[projectId] ?? EMPTY_THREAD_IDS;
    const nextThreadIds = next[projectId] ?? EMPTY_THREAD_IDS;
    if (!threadIdArraysEqual(previousThreadIds, nextThreadIds)) {
      return next;
    }
  }
  return previous as Record<string, ThreadId[]>;
}

function shouldRetainLeanThreadActivity(
  activity: Pick<Thread["activities"][number], "kind">,
): boolean {
  return LEAN_THREAD_ACTIVITY_KINDS.has(activity.kind);
}

function toLeanThread(thread: Thread): Thread {
  if (thread.historyLoaded === false) {
    return thread;
  }

  return {
    ...thread,
    messages: thread.messages.filter((message) => message.role === "user"),
    proposedPlans: [],
    latestProposedPlanSummary:
      thread.latestProposedPlanSummary ?? findLatestProposedPlanSummary(thread.proposedPlans),
    turnDiffSummaries: [],
    activities: thread.activities.filter(shouldRetainLeanThreadActivity),
    historyLoaded: false,
  };
}

function shouldKeepHydratedThreadHistory(
  thread: Thread,
  keepThreadIds: ReadonlySet<ThreadId>,
): boolean {
  if (keepThreadIds.has(thread.id)) {
    return true;
  }

  if (thread.latestTurn?.state === "running") {
    return true;
  }

  return (
    thread.session?.orchestrationStatus === "starting" ||
    thread.session?.orchestrationStatus === "running"
  );
}

export function pruneHydratedThreadHistories(
  state: AppState,
  keepThreadIds: readonly ThreadId[],
): AppState {
  const retainedThreadIds = new Set(keepThreadIds);
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (
      thread.historyLoaded === false ||
      shouldKeepHydratedThreadHistory(thread, retainedThreadIds)
    ) {
      return thread;
    }

    const leanThread = toLeanThread(thread);
    if (leanThread !== thread) {
      changed = true;
    }
    return leanThread;
  });

  if (!changed) {
    return state;
  }

  return {
    ...state,
    threads,
    threadsById: buildThreadsById(threads),
    sidebarThreadsById: buildSidebarThreadsByIdPreserving(
      threads,
      state.dismissedThreadErrorKeysById,
      state.sidebarThreadsById,
    ),
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function latestTurnFromSessionLifecycleEvent(
  thread: Thread,
  session: Extract<OrchestrationEvent, { type: "thread.session-set" }>["payload"]["session"],
): Thread["latestTurn"] {
  if (session.status === "running" && session.activeTurnId !== null) {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: session.activeTurnId,
      state: "running",
      requestedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.requestedAt
          : session.updatedAt,
      startedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? (thread.latestTurn.startedAt ?? session.updatedAt)
          : session.updatedAt,
      completedAt: null,
      assistantMessageId:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.assistantMessageId
          : null,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  const previous = thread.latestTurn;
  if (
    previous === null ||
    previous.state !== "running" ||
    session.activeTurnId !== null ||
    session.status === "running" ||
    session.status === "starting"
  ) {
    return previous;
  }

  const state =
    session.status === "ready" ? "completed" : session.status === "error" ? "error" : "interrupted";
  return buildLatestTurn({
    previous,
    turnId: previous.turnId,
    state,
    requestedAt: previous.requestedAt,
    startedAt: previous.startedAt ?? session.updatedAt,
    completedAt: previous.completedAt ?? session.updatedAt,
    assistantMessageId: previous.assistantMessageId,
  });
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: Thread["turnDiffSummaries"],
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : turnDiffSummaries;
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareSequenceThenCreatedAt(left, right) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareSequenceThenCreatedAt(left, right) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (Schema.is(ProviderKind)(providerName)) {
    return providerName;
  }
  return "codex";
}

function toAttachmentPreviewUrl(rawUrl: string, connectionUrl?: string): string {
  if (rawUrl.startsWith("/")) {
    try {
      let connectionToken: string | null = null;
      const resolveBaseUrl = (): URL => {
        if (connectionUrl) {
          const parsedConnectionUrl = new URL(connectionUrl);
          connectionToken = parsedConnectionUrl.searchParams.get("token");
          const protocol =
            parsedConnectionUrl.protocol === "wss:"
              ? "https:"
              : parsedConnectionUrl.protocol === "ws:"
                ? "http:"
                : parsedConnectionUrl.protocol;
          return new URL(`${protocol}//${parsedConnectionUrl.host}/`);
        }
        return new URL(resolveServerUrl({ pathname: "/" }));
      };
      const resolvedUrl = new URL(rawUrl, resolveBaseUrl());
      if (connectionToken && !resolvedUrl.searchParams.has("token")) {
        resolvedUrl.searchParams.set("token", connectionToken);
      }
      resolvedUrl.protocol =
        resolvedUrl.protocol === "wss:"
          ? "https:"
          : resolvedUrl.protocol === "ws:"
            ? "http:"
            : resolvedUrl.protocol;
      return resolvedUrl.toString();
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateThreadState(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): AppState {
  let updatedThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    const nextThread = updater(thread);
    if (nextThread !== thread) {
      updatedThread = nextThread;
    }
    return nextThread;
  });
  if (threads === state.threads || updatedThread === null) {
    return state;
  }

  const nextSummary = buildSidebarThreadSummary(updatedThread, state.dismissedThreadErrorKeysById);
  const previousSummary = state.sidebarThreadsById[threadId];
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [threadId]: nextSummary,
      };

  if (sidebarThreadsById === state.sidebarThreadsById) {
    return {
      ...state,
      threads,
      threadsById: {
        ...(state.threadsById ?? buildThreadsById(state.threads)),
        [threadId]: updatedThread,
      },
    };
  }

  return {
    ...state,
    threads,
    threadsById: {
      ...(state.threadsById ?? buildThreadsById(state.threads)),
      [threadId]: updatedThread,
    },
    sidebarThreadsById,
  };
}

function applyProjectEvent(state: AppState, event: OrchestrationEvent): AppState | null {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
      );
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        icon: event.payload.icon ?? null,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        archivedAt: event.payload.archivedAt ?? null,
        deletedAt: null,
      });
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...state.projects, nextProject];
      return { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.icon !== undefined ? { icon: event.payload.icon } : {}),
        ...(event.payload.archivedAt !== undefined ? { archivedAt: event.payload.archivedAt } : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return projects.length === state.projects.length ? state : { ...state, projects };
    }

    default:
      return null;
  }
}

function applyThreadEvent(state: AppState, event: OrchestrationEvent): AppState | null {
  switch (event.type) {
    case "thread.created": {
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const nextThread = mapThread({
        id: event.payload.threadId,
        projectId: event.payload.projectId,
        title: event.payload.title,
        modelSelection: event.payload.modelSelection,
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        ...(event.payload.handoff !== undefined ? { handoff: event.payload.handoff } : {}),
        queuedComposerMessages: [],
        queuedSteerRequest: null,
        latestTurn: null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        latestProposedPlanSummary: null,
        activities: [],
        checkpoints: [],
        session: null,
      });
      const threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      const nextSummary = buildSidebarThreadSummary(nextThread, state.dismissedThreadErrorKeysById);
      const previousSummary = state.sidebarThreadsById[nextThread.id];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarThreadsById
        : {
            ...state.sidebarThreadsById,
            [nextThread.id]: nextSummary,
          };
      const nextThreadIdsByProjectId =
        existing !== undefined && existing.projectId !== nextThread.projectId
          ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
          : state.threadIdsByProjectId;
      const threadIdsByProjectId = appendThreadIdByProjectId(
        nextThreadIdsByProjectId,
        nextThread.projectId,
        nextThread.id,
      );
      return {
        ...state,
        threads,
        threadsById: {
          ...(state.threadsById ?? buildThreadsById(state.threads)),
          [nextThread.id]: nextThread,
        },
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === state.threads.length) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      return {
        ...state,
        threads,
        threadsById: buildThreadsById(threads),
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.archived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.unarchived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.meta-updated": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        ...(event.payload.queuedComposerMessages !== undefined
          ? {
              queuedComposerMessages:
                event.payload.queuedComposerMessages.map(mapQueuedComposerMessage),
            }
          : {}),
        ...(event.payload.queuedSteerRequest !== undefined
          ? { queuedSteerRequest: event.payload.queuedSteerRequest }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.runtime-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.interaction-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.turn-start-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.message-sent": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const message = mapMessage(
          {
            id: event.payload.messageId,
            role: event.payload.role,
            text: event.payload.text,
            ...(event.payload.attachments !== undefined
              ? { attachments: event.payload.attachments }
              : {}),
            turnId: event.payload.turnId,
            streaming: event.payload.streaming,
            sequence: event.payload.sequence ?? event.sequence,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          },
          resolveConnectionForThreadId(event.payload.threadId),
        );
        const existingMessageIndex = thread.messages.findIndex((entry) => entry.id === message.id);
        const existingMessage =
          existingMessageIndex >= 0 ? thread.messages[existingMessageIndex] : undefined;
        const shouldRetainMessage =
          thread.historyLoaded !== false ||
          event.payload.role === "user" ||
          existingMessage !== undefined;
        const messages = !shouldRetainMessage
          ? thread.messages
          : existingMessage
            ? (() => {
                const nextMessages = [...thread.messages];
                const { streamingTextState: _previousStreamingTextState, ...restEntry } =
                  existingMessage;
                const nextStreamingTextState = message.streaming
                  ? appendChatMessageStreamingTextState(
                      existingMessage.streamingTextState ??
                        createChatMessageStreamingTextState(existingMessage.text),
                      event.payload.text,
                    )
                  : undefined;
                nextMessages[existingMessageIndex] = {
                  ...restEntry,
                  text: message.streaming
                    ? ""
                    : finalizeChatMessageText(existingMessage, message.text),
                  ...(nextStreamingTextState ? { streamingTextState: nextStreamingTextState } : {}),
                  streaming: message.streaming,
                  ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                  ...(existingMessage.sequence !== undefined || message.sequence !== undefined
                    ? { sequence: existingMessage.sequence ?? message.sequence }
                    : {}),
                  ...(message.streaming
                    ? existingMessage.completedAt !== undefined
                      ? { completedAt: existingMessage.completedAt }
                      : {}
                    : message.completedAt !== undefined
                      ? { completedAt: message.completedAt }
                      : {}),
                  ...(message.attachments !== undefined
                    ? { attachments: message.attachments }
                    : {}),
                };
                return nextMessages;
              })()
            : [...thread.messages, message];
        const cappedMessages = shouldRetainMessage
          ? messages.slice(-MAX_THREAD_MESSAGES)
          : messages;
        const turnDiffSummaries =
          thread.historyLoaded !== false &&
          event.payload.role === "assistant" &&
          event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                thread.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.turnDiffSummaries;
        const latestTurn: Thread["latestTurn"] =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: event.payload.streaming
                  ? "running"
                  : thread.latestTurn?.state === "interrupted"
                    ? "interrupted"
                    : thread.latestTurn?.state === "error"
                      ? "error"
                      : "completed",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.createdAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                    : event.payload.createdAt,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
                completedAt: event.payload.streaming
                  ? thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.completedAt ?? null)
                    : null
                  : event.payload.updatedAt,
                assistantMessageId: event.payload.messageId,
              })
            : thread.latestTurn;
        return {
          ...thread,
          messages: cappedMessages,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.session-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const session = mapSession(event.payload.session);
        const nextThread = {
          ...thread,
          session,
          error: resolveSessionVisibleError(event.payload.session),
          latestTurn: latestTurnFromSessionLifecycleEvent(thread, event.payload.session),
          updatedAt: event.occurredAt,
        };
        return suppressDismissedThreadError(nextThread, state.dismissedThreadErrorKeysById);
      });
    }

    case "thread.session-stop-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
      );
    }

    case "thread.proposed-plan-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans =
          thread.historyLoaded === false
            ? thread.proposedPlans
            : [
                ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
                proposedPlan,
              ]
                .toSorted(
                  (left, right) =>
                    left.createdAt.localeCompare(right.createdAt) ||
                    left.id.localeCompare(right.id),
                )
                .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
          latestProposedPlanSummary: toLatestProposedPlanSummary(proposedPlan),
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.turn-diff-completed": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          source: event.payload.source,
          ...(event.payload.diff !== undefined ? { diff: event.payload.diff } : {}),
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        if (
          existing &&
          existing.source === "provider-native" &&
          checkpoint.source === "provider-reconstructed"
        ) {
          return thread;
        }
        const turnDiffSummaries =
          thread.historyLoaded === false
            ? thread.turnDiffSummaries
            : [
                ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
                checkpoint,
              ]
                .toSorted(
                  (left, right) =>
                    (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                    (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
                )
                .slice(-MAX_THREAD_CHECKPOINTS);
        const latestTurn =
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.reverted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          turnDiffSummaries,
          messages,
          proposedPlans,
          latestProposedPlanSummary:
            thread.historyLoaded === false ? null : findLatestProposedPlanSummary(proposedPlans),
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.activity-appended": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const shouldRetainActivity =
          thread.historyLoaded !== false || shouldRetainLeanThreadActivity(event.payload.activity);
        const activities = !shouldRetainActivity
          ? thread.activities
          : appendCompactedThreadActivity(thread.activities, event.payload.activity, {
              maxEntries: DEFAULT_MAX_THREAD_ACTIVITIES,
            });
        return {
          ...thread,
          activities,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;

    default:
      return null;
  }
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(
  state: AppState,
  readModel: OrchestrationReadModel,
  options?: SnapshotSyncOptions,
): AppState {
  const existingThreadsById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const mappedThread = mapThread(thread, options);
      const nextThread = mergeThreadPreservingHydratedHistory(
        existingThreadsById.get(thread.id),
        mappedThread,
        options === undefined || mappedThread.historyLoaded,
      );
      if (options !== undefined && nextThread.historyLoaded !== false) {
        primeHydratedThreadCache(thread);
      }
      return suppressDismissedThreadError(nextThread, state.dismissedThreadErrorKeysById);
    });
  const sidebarThreadsById = buildSidebarThreadsByIdPreserving(
    threads,
    state.dismissedThreadErrorKeysById,
    state.sidebarThreadsById,
  );
  const threadIdsByProjectId = buildThreadIdsByProjectIdPreserving(
    threads,
    state.threadIdsByProjectId,
  );
  return {
    ...state,
    projects,
    threads,
    threadsById: buildThreadsById(threads),
    sidebarThreadsById,
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

export function mergeServerReadModel(
  state: AppState,
  readModel: OrchestrationReadModel,
  options?: SnapshotSyncOptions,
): AppState {
  const incomingProjects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const incomingThreads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const nextThread = suppressDismissedThreadError(
        mapThread(thread, options),
        state.dismissedThreadErrorKeysById,
      );
      if (options !== undefined && nextThread.historyLoaded !== false) {
        primeHydratedThreadCache(thread);
      }
      return nextThread;
    });

  const projectsById = new Map(state.projects.map((project) => [project.id, project] as const));
  for (const project of incomingProjects) {
    projectsById.set(project.id, project);
  }

  const threadsById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  for (const thread of incomingThreads) {
    threadsById.set(
      thread.id,
      mergeThreadPreservingHydratedHistory(threadsById.get(thread.id), thread),
    );
  }

  const projects = [...projectsById.values()];
  const threads = [...threadsById.values()];
  return {
    ...state,
    projects,
    threads,
    threadsById: buildThreadsById(threads),
    sidebarThreadsById: buildSidebarThreadsByIdPreserving(
      threads,
      state.dismissedThreadErrorKeysById,
      state.sidebarThreadsById,
    ),
    threadIdsByProjectId: buildThreadIdsByProjectIdPreserving(
      threads,
      state.threadIdsByProjectId,
    ),
    bootstrapComplete: true,
  };
}

export function removeReadModelEntities(
  state: AppState,
  input: {
    readonly projectIds: ReadonlyArray<ProjectId>;
    readonly threadIds: ReadonlyArray<ThreadId>;
  },
): AppState {
  if (input.projectIds.length === 0 && input.threadIds.length === 0) {
    return state;
  }
  const projectIds = new Set(input.projectIds);
  const threadIds = new Set(input.threadIds);
  const projects = state.projects.filter((project) => !projectIds.has(project.id));
  const threads = state.threads.filter((thread) => !threadIds.has(thread.id));
  return {
    ...state,
    projects,
    threads,
    threadsById: buildThreadsById(threads),
    sidebarThreadsById: buildSidebarThreadsByIdPreserving(
      threads,
      state.dismissedThreadErrorKeysById,
      state.sidebarThreadsById,
    ),
    threadIdsByProjectId: buildThreadIdsByProjectIdPreserving(
      threads,
      state.threadIdsByProjectId,
    ),
  };
}

export function hydrateThreadFromReadModel(
  state: AppState,
  readModelThread: OrchestrationReadModel["threads"][number],
  options?: SnapshotSyncOptions,
): AppState {
  if (readModelThread.deletedAt !== null) {
    return state;
  }

  primeHydratedThreadCache(readModelThread);
  const nextThread = { ...mapThread(readModelThread, options), historyLoaded: true };
  const existingThread = state.threads.find((thread) => thread.id === nextThread.id);
  const threads = existingThread
    ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
    : [...state.threads, nextThread];
  const nextSummary = buildSidebarThreadSummary(nextThread, state.dismissedThreadErrorKeysById);
  const previousSummary = state.sidebarThreadsById[nextThread.id];
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [nextThread.id]: nextSummary,
      };
  const nextThreadIdsByProjectId =
    existingThread !== undefined && existingThread.projectId !== nextThread.projectId
      ? removeThreadIdByProjectId(
          state.threadIdsByProjectId,
          existingThread.projectId,
          existingThread.id,
        )
      : state.threadIdsByProjectId;
  const threadIdsByProjectId = appendThreadIdByProjectId(
    nextThreadIdsByProjectId,
    nextThread.projectId,
    nextThread.id,
  );

  return {
    ...state,
    threads,
    threadsById: {
      ...(state.threadsById ?? buildThreadsById(state.threads)),
      [nextThread.id]: nextThread,
    },
    sidebarThreadsById,
    threadIdsByProjectId,
  };
}

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  const projectState = applyProjectEvent(state, event);
  if (projectState !== null) {
    return projectState;
  }

  const threadState = applyThreadEvent(state, event);
  return threadState ?? state;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}

export const selectProjectById =
  (projectId: Project["id"] | null | undefined) =>
  (state: AppState): Project | undefined =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined;

export const selectThreadById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): Thread | undefined =>
    getThreadByIdFromState(state, threadId);

export const selectSidebarThreadSummaryById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): SidebarThreadSummary | undefined =>
    threadId ? state.sidebarThreadsById[threadId] : undefined;

export const selectThreadIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): ThreadId[] =>
    projectId ? (state.threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS) : EMPTY_THREAD_IDS;

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function dismissThreadError(state: AppState, threadId: ThreadId): AppState {
  const thread = getThreadById(state.threads, threadId);
  if (!thread?.error) {
    return state;
  }

  const dismissalKey = resolveThreadErrorDismissalKey(thread);
  if (dismissalKey === null) {
    return state;
  }

  const dismissedThreadErrorKeysById =
    state.dismissedThreadErrorKeysById[threadId] === dismissalKey
      ? state.dismissedThreadErrorKeysById
      : {
          ...state.dismissedThreadErrorKeysById,
          [threadId]: dismissalKey,
        };
  const nextState =
    dismissedThreadErrorKeysById === state.dismissedThreadErrorKeysById
      ? state
      : {
          ...state,
          dismissedThreadErrorKeysById,
        };
  return setError(nextState, threadId, null);
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  resetToInitialState: () => void;
  syncServerReadModel: (readModel: OrchestrationReadModel, options?: SnapshotSyncOptions) => void;
  mergeServerReadModel: (readModel: OrchestrationReadModel, options?: SnapshotSyncOptions) => void;
  removeReadModelEntities: (input: {
    readonly projectIds: ReadonlyArray<ProjectId>;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) => void;
  hydrateThreadFromReadModel: (
    readModelThread: OrchestrationReadModel["threads"][number],
    options?: SnapshotSyncOptions,
  ) => void;
  pruneHydratedThreadHistories: (keepThreadIds: readonly ThreadId[]) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  dismissThreadError: (threadId: ThreadId) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  resetToInitialState: () => set(() => createInitialState()),
  syncServerReadModel: (readModel, options) =>
    set((state) => syncServerReadModel(state, readModel, options)),
  mergeServerReadModel: (readModel, options) =>
    set((state) => mergeServerReadModel(state, readModel, options)),
  removeReadModelEntities: (input) => set((state) => removeReadModelEntities(state, input)),
  hydrateThreadFromReadModel: (readModelThread, options) =>
    set((state) => hydrateThreadFromReadModel(state, readModelThread, options)),
  pruneHydratedThreadHistories: (keepThreadIds) =>
    set((state) => pruneHydratedThreadHistories(state, keepThreadIds)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  dismissThreadError: (threadId) => set((state) => dismissThreadError(state, threadId)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));
