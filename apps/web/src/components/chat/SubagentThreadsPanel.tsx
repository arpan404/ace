import { BotIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { MessageId, TrimmedNonEmptyString, type ProviderKind, type ThreadId } from "@ace/contracts";

import type { WorkLogEntry } from "../../session-logic/types";
import { deriveTimelineEntries } from "../../session-logic";
import { cn, newCommandId, newMessageId } from "../../lib/utils";
import { resolveSubagentIdentity } from "../../lib/subagentAdapters";
import { readNativeApi } from "../../nativeApi";
import { ScrollArea } from "../ui/scroll-area";
import { MessagesTimeline } from "./MessagesTimeline";
import { SideChatComposer } from "./SideChatComposer";
import type { ChatMessage } from "../../types";

export interface SubagentThread {
  readonly id: string;
  readonly label: string;
  readonly model?: string;
  readonly persona: SubagentPersona;
  readonly roleLabel?: string;
  readonly status: "running" | "completed" | "failed";
  readonly entries: ReadonlyArray<WorkLogEntry>;
}

export interface SubagentPersona {
  readonly avatarClassName: string;
  readonly haloClassName: string;
  readonly initials: string;
  readonly name: string;
  readonly pingClassName: string;
}

export function formatSubagentLabel(value: string | undefined): string | null {
  const normalized = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .split(" ")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function subagentThreadKey(entry: WorkLogEntry): string | null {
  return entry.subagentId ?? entry.subagentName ?? entry.subagentType ?? null;
}

const GENERATED_SUBAGENT_NAMES = [
  "Ada",
  "Cora",
  "Dax",
  "Iris",
  "Mira",
  "Nova",
  "Orion",
  "Rhea",
  "Sol",
  "Vega",
] as const;

const SUBAGENT_PERSONA_TONES = [
  {
    avatarClassName: "bg-sky-500/14 text-sky-500 ring-sky-500/24",
    haloClassName: "bg-sky-500/14",
    pingClassName: "bg-sky-400",
  },
  {
    avatarClassName: "bg-emerald-500/14 text-emerald-500 ring-emerald-500/24",
    haloClassName: "bg-emerald-500/14",
    pingClassName: "bg-emerald-400",
  },
  {
    avatarClassName: "bg-amber-500/14 text-amber-500 ring-amber-500/24",
    haloClassName: "bg-amber-500/14",
    pingClassName: "bg-amber-400",
  },
  {
    avatarClassName: "bg-fuchsia-500/14 text-fuchsia-500 ring-fuchsia-500/24",
    haloClassName: "bg-fuchsia-500/14",
    pingClassName: "bg-fuchsia-400",
  },
] as const;

function hashSubagentId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isGenericSubagentLabel(label: string): boolean {
  return /^(codex\s+)?subagent$/i.test(label.trim());
}

function initialsForName(name: string): string {
  const parts = name.replace(/[_-]+/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (parts[0]?.slice(0, 2) ?? "AI").toUpperCase();
}

function resolveSubagentPersona(input: { id: string; identityLabel: string }): SubagentPersona {
  const hash = hashSubagentId(input.id);
  const generatedName = GENERATED_SUBAGENT_NAMES[hash % GENERATED_SUBAGENT_NAMES.length] ?? "Nova";
  const name = isGenericSubagentLabel(input.identityLabel)
    ? `${generatedName} Agent`
    : input.identityLabel;
  const tone =
    SUBAGENT_PERSONA_TONES[hash % SUBAGENT_PERSONA_TONES.length] ?? SUBAGENT_PERSONA_TONES[0];
  return {
    ...tone,
    initials: initialsForName(name),
    name,
  };
}

function resolveThreadStatus(entries: ReadonlyArray<WorkLogEntry>): SubagentThread["status"] {
  if (entries.some((entry) => entry.status === "failed" || entry.tone === "error")) {
    return "failed";
  }
  if (entries.some((entry) => entry.status === "completed")) {
    return "completed";
  }
  const latestStatus = entries
    .filter((entry) => entry.status)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.status;
  if (latestStatus === "inProgress") {
    return "running";
  }
  return "completed";
}

export function deriveSubagentThreads(
  entries: ReadonlyArray<WorkLogEntry>,
  provider?: ProviderKind | null,
): SubagentThread[] {
  const grouped = new Map<string, WorkLogEntry[]>();
  for (const entry of entries) {
    const key = subagentThreadKey(entry);
    if (!key) {
      continue;
    }
    const group = grouped.get(key);
    if (group) {
      group.push(entry);
    } else {
      grouped.set(key, [entry]);
    }
  }

  return [...grouped.entries()]
    .map(([id, group]) => {
      const identity = resolveSubagentIdentity({ entries: group, fallbackId: id, provider });
      const persona = resolveSubagentPersona({ id, identityLabel: identity.label });
      const roleLabel = persona.name === identity.label ? null : identity.label;
      return {
        id,
        label: persona.name,
        ...(identity.model ? { model: identity.model } : {}),
        persona,
        ...(roleLabel ? { roleLabel } : {}),
        status: resolveThreadStatus(group),
        entries: group.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    })
    .toSorted((left, right) => {
      const leftLast = left.entries.at(-1)?.createdAt ?? "";
      const rightLast = right.entries.at(-1)?.createdAt ?? "";
      return rightLast.localeCompare(leftLast);
    });
}

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
  parentThreadId: ThreadId;
  timelineProps: ComponentProps<typeof MessagesTimeline>;
  threads: ReadonlyArray<SubagentThread>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const activeThread =
    props.threads.find((thread) => thread.id === props.activeThreadId) ?? props.threads[0] ?? null;
  const sideChatTimeline = useMemo(() => {
    const messages: ChatMessage[] = [];
    const workEntries: WorkLogEntry[] = [];
    for (const entry of activeThread?.entries ?? []) {
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
  }, [activeThread?.entries]);
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
  const handleSubmit = async (text: string) => {
    const api = readNativeApi();
    if (!api) {
      setSendError("Native API unavailable.");
      return;
    }
    setIsSending(true);
    setSendError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.subagent.turn.start",
        commandId: newCommandId(),
        threadId: props.parentThreadId,
        subagentThreadId: TrimmedNonEmptyString.makeUnsafe(activeThread.id),
        message: {
          messageId: newMessageId(),
          role: "user",
          text,
        },
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setIsSending(false);
    }
  };

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
          hasMessages={timelineEntries.length > 0}
          hideCompletedWorkMessages={false}
          isWorking={isSubagentWorking}
          liveTimers={props.timelineProps.liveTimers ?? true}
          onForkConversation={null}
          onStartConversationFromMessage={null}
          onToggleWorkGroup={onToggleWorkGroup}
          revertTurnCountByUserMessageId={new Map()}
          timelineEntries={timelineEntries}
          turnDiffSummaryByAssistantMessageId={new Map()}
        />
      </ScrollArea>
      <SideChatComposer
        className="border-t border-border/70"
        disabled={isSending}
        error={sendError}
        isSending={isSending}
        placeholder={`Message ${activeThread.label}`}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
