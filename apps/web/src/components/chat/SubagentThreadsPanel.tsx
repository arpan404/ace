import { BotIcon, MessageSquareIcon, SmileIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { MessageId, type ProviderKind } from "@ace/contracts";

import type { WorkLogEntry } from "../../session-logic/types";
import { deriveTimelineEntries } from "../../session-logic";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { MessagesTimeline } from "./MessagesTimeline";
import type { ChatMessage } from "../../types";
import {
  deriveSubagentThreads,
  resolveSubagentMainAgentMessage,
  type SubagentThread,
} from "./subagentThreads";

export function statusLabel(status: SubagentThread["status"]): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Completed";
}

export function formatSubagentSubtitle(thread: SubagentThread): string | null {
  return [thread.roleLabel, thread.model].filter(Boolean).join(" · ") || null;
}

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
          "relative inline-flex size-full items-center justify-center rounded-full ring-1 transition-transform duration-200 group-hover/subagent:scale-105",
          props.thread.persona.avatarClassName,
          props.status === "failed" && "bg-destructive/12 text-destructive ring-destructive/25",
          isRunning && "motion-safe:animate-pulse",
        )}
        aria-label={`${props.thread.label} persona`}
      >
        <SmileIcon className="size-[62%]" strokeWidth={2.25} />
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

export function SubagentThreadsPanel(props: {
  provider?: ProviderKind | null;
  workEntries: ReadonlyArray<WorkLogEntry>;
}) {
  const threads = useMemo(
    () => deriveSubagentThreads(props.workEntries, props.provider),
    [props.provider, props.workEntries],
  );

  if (threads.length === 0) {
    return null;
  }

  return (
    <section className="flex max-h-[45%] min-h-40 shrink-0 flex-col border-t border-border/70 bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <BotIcon className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Subagents</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{threads.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-2">
          {threads.map((thread) => (
            <article
              key={thread.id}
              className="overflow-hidden rounded-md border border-border/70 bg-card"
            >
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                <SubagentPersonaIcon status={thread.status} thread={thread} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{thread.label}</div>
                  {formatSubagentSubtitle(thread) ? (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {formatSubagentSubtitle(thread)}
                    </div>
                  ) : null}
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-normal",
                    thread.status === "running" && "bg-sky-500/12 text-sky-600",
                    thread.status === "completed" && "bg-emerald-500/12 text-emerald-600",
                    thread.status === "failed" && "bg-destructive/12 text-destructive",
                  )}
                >
                  {statusLabel(thread.status)}
                </span>
              </div>
              <div className="max-h-72 overflow-y-auto px-3 py-2">
                <ol className="space-y-2">
                  {thread.entries.map((entry) => (
                    <li key={entry.id} className="border-l border-border/70 pl-2.5">
                      <div className="truncate text-xs font-medium">{entry.label}</div>
                      {entry.detail ? (
                        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-4 text-muted-foreground">
                          {entry.detail}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SubagentWorkspacePanel(props: {
  activeThreadId: string | null;
  composer: (thread: SubagentThread) => ReactNode;
  isForkConversationDisabled?: boolean;
  onForkConversation?: ((thread: SubagentThread) => void) | null;
  timelineProps: ComponentProps<typeof MessagesTimeline>;
  threads: ReadonlyArray<SubagentThread>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const activeThread =
    props.threads.find((thread) => thread.id === props.activeThreadId) ?? props.threads[0] ?? null;
  const mainAgentMessageEntry = activeThread ? resolveSubagentMainAgentMessage(activeThread) : null;
  const sideChatTimeline = useMemo(() => {
    const messages: ChatMessage[] = [];
    const workEntries: WorkLogEntry[] = [];
    for (const entry of activeThread?.entries ?? []) {
      if (mainAgentMessageEntry && entry.id === mainAgentMessageEntry.id) {
        continue;
      }
      if (entry.sideChatMessageRole && entry.sideChatMessageText) {
        messages.push({
          id: MessageId.makeUnsafe(entry.sideChatMessageId ?? entry.id),
          role: entry.sideChatMessageRole,
          text: entry.sideChatMessageText,
          turnId: null,
          createdAt: entry.createdAt,
          ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
          streaming: false,
        });
      } else {
        workEntries.push(entry);
      }
    }
    return {
      messages,
      workEntries,
    };
  }, [activeThread?.entries, mainAgentMessageEntry]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(sideChatTimeline.messages, [], sideChatTimeline.workEntries),
    [sideChatTimeline],
  );

  if (!activeThread) {
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          No subagent conversations yet.
        </div>
      </section>
    );
  }

  const activeThreadStartedAt =
    activeThread.entries.find((entry) => entry.status === "inProgress")?.createdAt ??
    activeThread.entries[0]?.createdAt ??
    null;
  const isSubagentWorking = activeThread.status === "running";

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1 px-3 py-4 sm:px-5" viewportRef={scrollContainerRef}>
        {mainAgentMessageEntry?.sideChatMessageText ? (
          <div className="mx-auto mb-4 w-full max-w-3xl rounded-lg border border-border/70 bg-card/65 px-3.5 py-3 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <MessageSquareIcon className="size-3.5" />
              <span>Main agent</span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
              {mainAgentMessageEntry.sideChatMessageText}
            </p>
          </div>
        ) : null}
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
          hasMessages={timelineEntries.length > 0}
          hideCompletedWorkMessages={false}
          isWorking={isSubagentWorking}
          liveTimers={props.timelineProps.liveTimers ?? true}
          onForkConversation={
            props.onForkConversation ? () => props.onForkConversation?.(activeThread) : null
          }
          isForkConversationDisabled={
            props.isForkConversationDisabled === true || isSubagentWorking
          }
          onStartConversationFromMessage={null}
          onToggleWorkGroup={onToggleWorkGroup}
          revertTurnCountByUserMessageId={new Map()}
          timelineEntries={timelineEntries}
          turnDiffSummaryByAssistantMessageId={new Map()}
        />
      </ScrollArea>
      <div>{props.composer(activeThread)}</div>
    </section>
  );
}
