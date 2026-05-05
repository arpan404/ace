import { type MessageId } from "@ace/contracts";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveVisibleTurnDiffSummaryByAssistantMessageId,
  deriveWorkLogEntries,
  filterVisibleWorkLogActivities,
} from "../../session-logic";
import { type ChatMessage, type Thread, type TurnDiffSummary } from "../../types";
import { measureRenderWork } from "../renderProfiling";

export interface ThreadActivityVisibilitySettings {
  readonly enableThinkingStreaming: boolean;
  readonly enableToolStreaming: boolean;
}

interface ThreadActivityRenderState {
  readonly visibleThreadActivities: ReturnType<typeof filterVisibleWorkLogActivities>;
  readonly workLogEntries: ReturnType<typeof deriveWorkLogEntries>;
  readonly pendingApprovals: ReturnType<typeof derivePendingApprovals>;
  readonly pendingUserInputs: ReturnType<typeof derivePendingUserInputs>;
}

interface ThreadTimelineRenderState {
  readonly timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  readonly turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  readonly visibleTurnDiffSummaryByAssistantMessageId: ReturnType<
    typeof deriveVisibleTurnDiffSummaryByAssistantMessageId
  >;
}

type ThreadActivities = ReadonlyArray<Thread["activities"][number]>;
type ThreadProposedPlans = ReadonlyArray<Thread["proposedPlans"][number]>;
type WorkLogEntries = ReadonlyArray<ReturnType<typeof deriveWorkLogEntries>[number]>;

const activityRenderStateCache = new WeakMap<
  ThreadActivities,
  Map<string, ThreadActivityRenderState>
>();
const timelineRenderStateCache = new WeakMap<
  ReadonlyArray<ChatMessage>,
  WeakMap<
    ThreadProposedPlans,
    WeakMap<WorkLogEntries, WeakMap<ReadonlyArray<TurnDiffSummary>, ThreadTimelineRenderState>>
  >
>();

function activityVisibilityCacheKey(input: ThreadActivityVisibilitySettings): string {
  return `${input.enableThinkingStreaming ? "1" : "0"}:${input.enableToolStreaming ? "1" : "0"}`;
}

function getTimelineRenderStateBucket(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ThreadProposedPlans,
  workLogEntries: WorkLogEntries,
): WeakMap<ReadonlyArray<TurnDiffSummary>, ThreadTimelineRenderState> {
  let proposedPlanBucket = timelineRenderStateCache.get(messages);
  if (!proposedPlanBucket) {
    proposedPlanBucket = new WeakMap();
    timelineRenderStateCache.set(messages, proposedPlanBucket);
  }

  let workLogBucket = proposedPlanBucket.get(proposedPlans);
  if (!workLogBucket) {
    workLogBucket = new WeakMap();
    proposedPlanBucket.set(proposedPlans, workLogBucket);
  }

  let turnDiffBucket = workLogBucket.get(workLogEntries);
  if (!turnDiffBucket) {
    turnDiffBucket = new WeakMap();
    workLogBucket.set(workLogEntries, turnDiffBucket);
  }

  return turnDiffBucket;
}

export function deriveThreadActivityRenderState(
  activities: ThreadActivities,
  visibility: ThreadActivityVisibilitySettings,
): ThreadActivityRenderState {
  const cacheKey = activityVisibilityCacheKey(visibility);
  const cachedStates = activityRenderStateCache.get(activities);
  const cachedState = cachedStates?.get(cacheKey);
  if (cachedState) {
    return cachedState;
  }

  const visibleThreadActivities = filterVisibleWorkLogActivities(activities, visibility);
  const derivedWorkLogEntries = deriveWorkLogEntries(visibleThreadActivities);
  const nextState = {
    visibleThreadActivities,
    workLogEntries: visibility.enableThinkingStreaming
      ? derivedWorkLogEntries
      : derivedWorkLogEntries.filter((entry) => entry.tone !== "thinking"),
    pendingApprovals: derivePendingApprovals(activities),
    pendingUserInputs: derivePendingUserInputs(activities),
  } satisfies ThreadActivityRenderState;

  const nextCachedStates = cachedStates ?? new Map<string, ThreadActivityRenderState>();
  nextCachedStates.set(cacheKey, nextState);
  if (!cachedStates) {
    activityRenderStateCache.set(activities, nextCachedStates);
  }
  return nextState;
}

export function deriveThreadTimelineRenderState(input: {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlans: ThreadProposedPlans;
  readonly workLogEntries: WorkLogEntries;
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
}): ThreadTimelineRenderState {
  const cacheBucket = getTimelineRenderStateBucket(
    input.messages,
    input.proposedPlans,
    input.workLogEntries,
  );
  const cachedState = cacheBucket.get(input.turnDiffSummaries);
  if (cachedState) {
    return cachedState;
  }

  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (!summary.assistantMessageId) {
      continue;
    }
    turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
  }

  const nextState = {
    timelineEntries: measureRenderWork("chat.deriveTimelineEntries", () =>
      deriveTimelineEntries(input.messages, input.proposedPlans, input.workLogEntries),
    ),
    turnDiffSummaryByAssistantMessageId,
    visibleTurnDiffSummaryByAssistantMessageId: deriveVisibleTurnDiffSummaryByAssistantMessageId(
      input.messages,
      input.turnDiffSummaries,
    ),
  } satisfies ThreadTimelineRenderState;

  cacheBucket.set(input.turnDiffSummaries, nextState);
  return nextState;
}
