import {
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ThreadHandoff,
  type ThreadId,
} from "@ace/contracts";

import type { ChatMessage, ProposedPlan, Thread } from "../../types";
import {
  type ActivityVisibilitySettings,
  type WorkLogEntry,
  deriveWorkLogEntries,
  filterVisibleWorkLogActivities,
} from "../../session-logic";

export type HandoffLineageResult = {
  readonly threads: ReadonlyArray<Thread>;
  readonly missingThreadId: ThreadId | null;
  readonly hasCycle: boolean;
};

export function resolveHandoffLineage(input: {
  readonly sourceThreadId: ThreadId;
  readonly threads: ReadonlyArray<Thread>;
}): HandoffLineageResult {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const lineageNewestFirst: Thread[] = [];
  const visited = new Set<string>();
  let currentThreadId: ThreadId | null = input.sourceThreadId;

  while (currentThreadId !== null) {
    const thread = threadsById.get(currentThreadId);
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
    currentThreadId = thread.handoff?.sourceThreadId ?? null;
  }

  return {
    threads: lineageNewestFirst.toReversed(),
    missingThreadId: null,
    hasCycle: false,
  };
}

const HANDOFF_MESSAGE_PREFIX = "handoff";

function formatProviderLabel(provider: ProviderKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export function formatHandoffMarkerText(handoff: ThreadHandoff): string {
  const fromLabel = formatProviderLabel(handoff.fromProvider);
  const toLabel = formatProviderLabel(handoff.toProvider);
  const modeLabel = handoff.mode === "compact" ? "compact summary" : "full transcript";
  return `Handoff from ${fromLabel} to ${toLabel} — ${modeLabel} passed along.`;
}

export function buildHandoffMarkerMessage(handoff: ThreadHandoff): ChatMessage {
  const messageId = MessageId.makeUnsafe(
    `${HANDOFF_MESSAGE_PREFIX}:${handoff.createdAt}:${handoff.sourceThreadId}:${handoff.toProvider}`,
  );
  return {
    id: messageId,
    role: "system",
    text: formatHandoffMarkerText(handoff),
    createdAt: handoff.createdAt,
    streaming: false,
  };
}

export type HandoffTimelineResult = {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlans: ReadonlyArray<ProposedPlan>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly historicalMessageIds: ReadonlySet<MessageId>;
};

export function buildHandoffTimeline(input: {
  readonly activeThread: Thread;
  readonly activeThreadMessages: ReadonlyArray<ChatMessage>;
  readonly activeThreadWorkEntries: ReadonlyArray<WorkLogEntry>;
  readonly handoffLineage?: HandoffLineageResult | null | undefined;
  readonly activityVisibility?: ActivityVisibilitySettings | undefined;
}): HandoffTimelineResult {
  const messages: ChatMessage[] = [];
  const proposedPlans: ProposedPlan[] = [];
  const workEntries: WorkLogEntry[] = [];
  const historicalMessageIds = new Set<MessageId>();

  if (!input.handoffLineage || input.handoffLineage.hasCycle) {
    if (input.handoffLineage?.hasCycle) {
      const warningId = MessageId.makeUnsafe(
        `${HANDOFF_MESSAGE_PREFIX}:cycle:${input.activeThread.createdAt}`,
      );
      messages.push({
        id: warningId,
        role: "system",
        text: "Handoff history unavailable because the lineage contains a cycle.",
        createdAt: input.activeThread.createdAt,
        streaming: false,
      });
    }
    messages.push(...input.activeThreadMessages);
    proposedPlans.push(...input.activeThread.proposedPlans);
    workEntries.push(...input.activeThreadWorkEntries);
    return { messages, proposedPlans, workEntries, historicalMessageIds };
  }

  const orderedThreads = [...input.handoffLineage.threads, input.activeThread];
  if (input.handoffLineage.missingThreadId && orderedThreads.length > 0) {
    const firstThread = orderedThreads[0];
    if (firstThread?.handoff) {
      messages.push(buildHandoffMarkerMessage(firstThread.handoff));
    }
  }
  for (let index = 0; index < orderedThreads.length; index += 1) {
    const thread = orderedThreads[index];
    if (!thread) {
      continue;
    }
    const isActive = thread.id === input.activeThread.id;
    const threadMessages = isActive ? input.activeThreadMessages : thread.messages;
    messages.push(...threadMessages);
    if (!isActive) {
      for (const message of threadMessages) {
        historicalMessageIds.add(message.id);
      }
    }
    proposedPlans.push(...thread.proposedPlans);
    const threadWorkEntries = isActive
      ? input.activeThreadWorkEntries
      : deriveWorkLogEntries(
          input.activityVisibility
            ? filterVisibleWorkLogActivities(thread.activities ?? [], input.activityVisibility)
            : (thread.activities ?? []),
        );
    if (isActive) {
      workEntries.push(...threadWorkEntries);
    } else {
      workEntries.push(
        ...threadWorkEntries.map((entry) =>
          entry.sequence !== undefined ? Object.assign({}, entry, { sequence: undefined }) : entry,
        ),
      );
    }
    const nextThread = orderedThreads[index + 1];
    if (nextThread?.handoff) {
      messages.push(buildHandoffMarkerMessage(nextThread.handoff));
    }
  }

  return { messages, proposedPlans, workEntries, historicalMessageIds };
}
