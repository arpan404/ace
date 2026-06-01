import {
  BotIcon,
  CheckCircle2Icon,
  Clock3Icon,
  MessageSquareIcon,
  SearchIcon,
  TerminalSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo } from "react";
import type { ProviderKind } from "@ace/contracts";

import type { WorkLogEntry } from "../../session-logic/types";
import { cn } from "../../lib/utils";
import { resolveSubagentIdentity } from "../../lib/subagentAdapters";

export interface SubagentThread {
  readonly id: string;
  readonly label: string;
  readonly model?: string;
  readonly status: "running" | "completed" | "failed";
  readonly entries: ReadonlyArray<WorkLogEntry>;
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

function resolveThreadStatus(entries: ReadonlyArray<WorkLogEntry>): SubagentThread["status"] {
  if (entries.some((entry) => entry.status === "failed" || entry.tone === "error")) {
    return "failed";
  }
  if (entries.some((entry) => entry.status === "inProgress")) {
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
      return {
        id,
        label: identity.label,
        ...(identity.model ? { model: identity.model } : {}),
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

function StatusIcon(props: { status: SubagentThread["status"] }) {
  if (props.status === "running") {
    return <Clock3Icon className="size-3.5 text-sky-500" />;
  }
  if (props.status === "failed") {
    return <MessageSquareIcon className="size-3.5 text-destructive" />;
  }
  return <CheckCircle2Icon className="size-3.5 text-emerald-500" />;
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
                <StatusIcon status={thread.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{thread.label}</div>
                  {thread.model ? (
                    <div className="truncate text-[11px] text-muted-foreground">{thread.model}</div>
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
                  {thread.status}
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

function entryIcon(entry: WorkLogEntry) {
  const text = `${entry.label} ${entry.toolTitle ?? ""}`.toLowerCase();
  if (entry.command || entry.itemType === "command_execution") {
    return TerminalSquareIcon;
  }
  if (/\b(search|grep|find|rg|ripgrep)\b/.test(text)) {
    return SearchIcon;
  }
  if (entry.tone === "thinking") {
    return MessageSquareIcon;
  }
  return WrenchIcon;
}

function entryTitle(entry: WorkLogEntry): string {
  if (entry.intentText) {
    return "Subagent task";
  }
  if (entry.command) {
    return `Ran ${entry.command}`;
  }
  if (entry.tone === "thinking") {
    return "Reasoning";
  }
  return entry.toolTitle ?? entry.label;
}

function statusLabel(status: SubagentThread["status"]): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Completed";
}

export function SubagentWorkspacePanel(props: {
  activeThreadId: string | null;
  threads: ReadonlyArray<SubagentThread>;
}) {
  const activeThread =
    props.threads.find((thread) => thread.id === props.activeThreadId) ?? props.threads[0] ?? null;

  if (!activeThread) {
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          No subagent conversations yet.
        </div>
      </section>
    );
  }

  const taskEntry = activeThread.entries.find((entry) => entry.intentText || entry.detail);
  const taskText = taskEntry?.intentText ?? taskEntry?.detail ?? null;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-5">
        <StatusIcon status={activeThread.status} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{activeThread.label}</h2>
          {activeThread.model ? (
            <p className="truncate text-xs text-muted-foreground">{activeThread.model}</p>
          ) : null}
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-normal",
            activeThread.status === "running" && "bg-sky-500/12 text-sky-500",
            activeThread.status === "completed" && "bg-emerald-500/12 text-emerald-500",
            activeThread.status === "failed" && "bg-destructive/12 text-destructive",
          )}
        >
          {statusLabel(activeThread.status)}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-8">
          {taskText ? (
            <div className="ml-auto max-w-3xl rounded-2xl bg-muted px-5 py-4 text-sm leading-6 text-foreground">
              {taskText}
            </div>
          ) : null}
          <div className="mt-2 text-sm text-muted-foreground">
            {activeThread.status === "running" ? "Working" : statusLabel(activeThread.status)}
          </div>
          <div className="border-t border-border/70" />
          <ol className="space-y-5">
            {activeThread.entries.map((entry) => {
              const Icon = entryIcon(entry);
              const title = entryTitle(entry);
              const detail = entry.intentText
                ? entry.detail
                : (entry.detail ?? entry.terminalOutput);
              return (
                <li key={entry.id} className="grid grid-cols-[22px_1fr] gap-3">
                  <div className="pt-0.5 text-muted-foreground">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="break-words text-sm leading-6 text-foreground">{title}</div>
                    {detail ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                        {detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
