import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  formatElapsed,
  hasLiveTurn,
  isLatestTurnSettled,
} from "../../session-logic";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic/types";
import type { ChatMessage, ProposedPlan, Thread, TurnDiffSummary } from "../../types";
import { fnv1a32 } from "../diffRendering";
import {
  deriveThreadActivityRenderState,
  deriveThreadTimelineRenderState,
  type ThreadActivityVisibilitySettings,
} from "./threadRenderState";
import type { BuildTimelineRowsInput } from "./timelineRows";

type TimelineCacheThread = Pick<
  Thread,
  "id" | "historyLoaded" | "latestTurn" | "modelSelection" | "session" | "updatedAt"
>;

interface ThreadTimelineCacheScopeInput {
  readonly thread: TimelineCacheThread | null | undefined;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly timelineProposedPlans: ReadonlyArray<ProposedPlan>;
  readonly timelineWorkEntries: ReadonlyArray<WorkLogEntry>;
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
}

interface ThreadTimelineRowsInputOptions {
  readonly enableGoalWorkingState: boolean;
  readonly hideCompletedWorkMessages: boolean;
  readonly visibility: ThreadActivityVisibilitySettings;
}

interface ThreadTimelineRowsInputResult {
  readonly input: BuildTimelineRowsInput;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
}

const CONTENT_TOKEN_SAMPLE_CHARS = 512;

function contentToken(value: string | null | undefined): string {
  if (!value) {
    return "0:0";
  }
  const sample =
    value.length <= CONTENT_TOKEN_SAMPLE_CHARS * 2
      ? value
      : `${value.slice(0, CONTENT_TOKEN_SAMPLE_CHARS)}\n${value.slice(-CONTENT_TOKEN_SAMPLE_CHARS)}`;
  return `${value.length}:${fnv1a32(sample).toString(36)}`;
}

function timelineEntryTailToken(entry: TimelineEntry | undefined): string {
  if (!entry) {
    return "none";
  }
  if (entry.kind === "message") {
    return [
      "message",
      entry.message.id,
      entry.message.role,
      entry.message.streaming ? "streaming" : "complete",
      entry.message.sequence ?? "no-seq",
      entry.message.completedAt ?? "no-completed",
      contentToken(entry.message.text),
    ].join("/");
  }
  if (entry.kind === "work") {
    return [
      "work",
      entry.entry.id,
      entry.entry.turnId ?? "no-turn",
      entry.entry.sequence ?? "no-seq",
      entry.entry.status ?? "no-status",
      entry.entry.exitCode ?? "no-exit",
      contentToken(`${entry.entry.label}\n${entry.entry.detail ?? ""}`),
    ].join("/");
  }
  if (entry.kind === "proposed-plan") {
    return [
      "plan",
      entry.proposedPlan.id,
      entry.proposedPlan.updatedAt,
      entry.proposedPlan.implementedAt ?? "pending",
      contentToken(entry.proposedPlan.planMarkdown),
    ].join("/");
  }
  return ["intent", entry.id, contentToken(entry.text)].join("/");
}

export function buildThreadTimelineCacheScope(input: ThreadTimelineCacheScopeInput): string | null {
  const thread = input.thread;
  if (!thread?.id) {
    return null;
  }

  const firstEntry = input.timelineEntries[0];
  const lastEntry = input.timelineEntries.at(-1);
  const lastMessage = input.timelineMessages.at(-1);
  const lastWorkEntry = input.timelineWorkEntries.at(-1);
  const lastProposedPlan = input.timelineProposedPlans.at(-1);
  const lastTurnDiffSummary = input.turnDiffSummaries.at(-1);

  return [
    "thread",
    thread.id,
    thread.historyLoaded === false ? "lean" : "hydrated",
    thread.updatedAt ?? "none",
    thread.latestTurn?.turnId ?? "no-turn",
    thread.latestTurn?.state ?? "no-state",
    thread.latestTurn?.completedAt ?? "no-turn-completed",
    input.timelineEntries.length,
    firstEntry?.id ?? "none",
    firstEntry?.createdAt ?? "none",
    timelineEntryTailToken(lastEntry),
    input.timelineMessages.length,
    lastMessage?.id ?? "none",
    lastMessage?.createdAt ?? "none",
    lastMessage?.completedAt ?? "none",
    contentToken(lastMessage?.text),
    input.timelineWorkEntries.length,
    lastWorkEntry?.id ?? "none",
    lastWorkEntry?.turnId ?? "none",
    lastWorkEntry?.createdAt ?? "none",
    lastWorkEntry?.status ?? "none",
    input.timelineProposedPlans.length,
    lastProposedPlan?.id ?? "none",
    lastProposedPlan?.updatedAt ?? lastProposedPlan?.createdAt ?? "none",
    input.turnDiffSummaries.length,
    lastTurnDiffSummary?.turnId ?? "none",
    lastTurnDiffSummary?.completedAt ?? "none",
  ].join(":");
}

export function deriveThreadCompletionSummary(
  latestTurn: Thread["latestTurn"],
  latestTurnSettled: boolean,
): string | null {
  if (!latestTurnSettled) return null;
  if (!latestTurn?.startedAt) return null;
  if (!latestTurn.completedAt) return null;

  const elapsed = formatElapsed(latestTurn.startedAt, latestTurn.completedAt);
  return elapsed ? `Worked for ${elapsed}` : null;
}

export function buildThreadTimelineRowsInput(
  thread: Thread,
  options: ThreadTimelineRowsInputOptions,
): ThreadTimelineRowsInputResult {
  const activityState = deriveThreadActivityRenderState(thread.activities, options.visibility);
  const timelineState = deriveThreadTimelineRenderState({
    messages: thread.messages,
    proposedPlans: thread.proposedPlans,
    workLogEntries: activityState.workLogEntries,
    turnDiffSummaries: thread.turnDiffSummaries,
  });
  const latestTurnSettled = isLatestTurnSettled(thread.latestTurn, thread.session);
  const isWorking = hasLiveTurn(thread.latestTurn, thread.session);
  const completionSummary = deriveThreadCompletionSummary(thread.latestTurn, latestTurnSettled);
  const completionDividerBeforeEntryId =
    latestTurnSettled && completionSummary
      ? deriveCompletionDividerBeforeEntryId(timelineState.timelineEntries, thread.latestTurn)
      : null;
  const cacheScopeKey = buildThreadTimelineCacheScope({
    thread,
    timelineEntries: timelineState.timelineEntries,
    timelineMessages: thread.messages,
    timelineProposedPlans: thread.proposedPlans,
    timelineWorkEntries: activityState.workLogEntries,
    turnDiffSummaries: thread.turnDiffSummaries,
  });

  return {
    input: {
      timelineEntries: timelineState.timelineEntries,
      activeTurnInProgress: isWorking || !latestTurnSettled,
      activeTurnStartedAt: deriveActiveWorkStartedAt(thread.latestTurn, thread.session, null),
      ...(cacheScopeKey ? { cacheScopeKey } : {}),
      completionDividerBeforeEntryId,
      completionSummary,
      hideCompletedWorkMessages: options.hideCompletedWorkMessages,
      isWorking,
      enableGoalWorkingState: options.enableGoalWorkingState,
    },
    timelineEntries: timelineState.timelineEntries,
  };
}
