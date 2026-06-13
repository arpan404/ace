import { useRef, useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { MessagesTimeline } from "./MessagesTimeline";
import type { SubagentThread } from "./subagentThreads";
import {
  toggleTimelineDisclosureExpansion,
  type TimelineDisclosureExpansionState,
  type TimelineDisclosureKey,
} from "../../lib/chat/timelineDisclosureState";
import { useSubagentTimelineViewModel } from "../../lib/chat/threadTimelineViewModel";

export function SubagentPersonaIcon(props: {
  className?: string;
  status: SubagentThread["status"];
  thread: SubagentThread;
}) {
  const isRunning = props.status === "running";
  return (
    <span
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center",
        props.className,
      )}
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full opacity-0 blur-[1px]",
          props.thread.persona.haloClassName,
          isRunning && "opacity-100 motion-safe:animate-pulse",
        )}
      />
      <span
        className={cn(
          "relative inline-flex size-full items-center justify-center rounded-full text-[10px] font-semibold ring-1",
          props.thread.persona.avatarClassName,
          props.status === "failed" && "bg-destructive/12 text-destructive ring-destructive/25",
        )}
      >
        {props.thread.persona.initials}
      </span>
      <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-2.5 items-center justify-center">
        {isRunning ? (
          <span
            className={cn(
              "absolute inline-flex size-2 rounded-full opacity-75 motion-safe:animate-ping",
              props.thread.persona.pingClassName,
            )}
          />
        ) : null}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full ring-2 ring-background",
            props.status === "running" && props.thread.persona.pingClassName,
            props.status === "completed" && "bg-emerald-500",
            props.status === "failed" && "bg-destructive",
          )}
        />
      </span>
    </span>
  );
}

export function SubagentWorkspacePanel(props: {
  activeThreadId: string | null;
  composer: (thread: SubagentThread) => ReactNode;
  timelineProps: ComponentProps<typeof MessagesTimeline>;
  threads: ReadonlyArray<SubagentThread>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [expandedWorkGroupsByThreadId, setExpandedWorkGroupsByThreadId] = useState<
    Record<string, TimelineDisclosureExpansionState>
  >({});
  const activeThread =
    props.threads.find((thread) => thread.id === props.activeThreadId) ?? props.threads[0] ?? null;
  const expandedWorkGroups = activeThread
    ? (expandedWorkGroupsByThreadId[activeThread.id] ?? {})
    : {};
  const timelineViewModel = useSubagentTimelineViewModel({
    thread: activeThread,
    enabled: activeThread !== null,
    surface: "subagent",
  });
  const onToggleWorkGroup = (groupId: TimelineDisclosureKey, defaultExpanded = false) => {
    if (!activeThread) {
      return;
    }
    setExpandedWorkGroupsByThreadId((existingByThreadId) => {
      const existing = existingByThreadId[activeThread.id] ?? {};
      return {
        ...existingByThreadId,
        [activeThread.id]: toggleTimelineDisclosureExpansion(existing, groupId, defaultExpanded),
      };
    });
  };
  const activeThreadStartedAt = timelineViewModel.activeTurnStartedAt;
  const isSubagentWorking = timelineViewModel.activeTurnInProgress;

  if (!activeThread) {
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          No subagent conversations yet.
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1 px-3 py-4 sm:px-5" viewportRef={scrollContainerRef}>
        <MessagesTimeline
          key={activeThread.id}
          {...props.timelineProps}
          activeTurnInProgress={isSubagentWorking}
          activeTurnStartedAt={activeThreadStartedAt}
          backgroundMarkdownPrewarm={props.timelineProps.backgroundMarkdownPrewarm ?? true}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          expandedWorkGroups={expandedWorkGroups}
          getScrollContainer={() => scrollContainerRef.current}
          hasMessages={timelineViewModel.hasEntries}
          hideCompletedWorkMessages={false}
          isWorking={isSubagentWorking}
          liveTimers={props.timelineProps.liveTimers ?? true}
          onForkConversation={null}
          onStartConversationFromMessage={null}
          onToggleWorkGroup={onToggleWorkGroup}
          revertTurnCountByUserMessageId={new Map()}
          rows={timelineViewModel.rows}
          timelineIndexByEntryId={timelineViewModel.timelineIndexByEntryId}
          timelineRowsLoading={timelineViewModel.loading}
          turnDiffSummaryByAssistantMessageId={new Map()}
        />
      </ScrollArea>
      <div>{props.composer(activeThread)}</div>
    </section>
  );
}
