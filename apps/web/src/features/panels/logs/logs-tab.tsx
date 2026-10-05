import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import {
  ArrowLineDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  ScrollIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { LongRows } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { ToolbarButton } from "../terminal/toolbar.tsx";
import { WithServices } from "../with-services.tsx";
import { hideLogLines, showLogLines } from "./cleared.ts";
import { DaemonLog } from "./daemon-log.tsx";
import { agentSubtree, filterLog, formatLog, readFilter, type LogFilter } from "./log-filter.ts";
import { FilterMenus, ScopeMenu, useThreadAgents } from "./log-menus.tsx";
import { parseLogScope } from "./scopes.ts";
import { logEqual, threadLog, type LogLine } from "./thread-log.ts";

/** Items that can log a line. Messages and reasoning never do, so their streaming costs nothing. */
const logs = (item: Item) =>
  item.type === "tool_call" || item.type === "notice" || item.type === "compaction";

/**
 * The keys the log derives from beyond the lists themselves: every agent, task and interaction,
 * the items that can log a line and the runs of the window's turns. An item's type and run never
 * change, so this is re-read only when the lists or the order do.
 */
const readKeys = (reader: ThreadReader): ThreadKey[] => {
  const keys: ThreadKey[] = [
    ...reader.agentIds().map((id): ThreadKey => `agent:${id}`),
    ...reader.taskIds().map((id): ThreadKey => `task:${id}`),
    ...reader.interactionIds().map((id): ThreadKey => `interaction:${id}`),
  ];
  const runs = new Set<string>();
  for (const id of reader.order) {
    const item = reader.item(id);
    if (!item) continue;
    if (item.runId && !runs.has(item.runId)) {
      runs.add(item.runId);
      keys.push(`run:${item.runId}`);
    }
    if (logs(item)) keys.push(`item:${id}`);
  }
  return keys;
};
const noLines: readonly LogLine[] = [];

/**
 * The thread's log lines, live. Re-derived only when an entity that can change a line does
 * (not on every streamed message delta).
 */
export function useThreadLog(threadId: string): readonly LogLine[] {
  const followed = useThread(
    threadId,
    ["order", "agents", "tasks", "interactions"],
    readKeys,
    arrayEqual,
  );
  const keys = useMemo<ThreadKey[]>(
    () => ["thread", "order", "agents", "tasks", "interactions", ...(followed ?? [])],
    [followed],
  );
  return useThread(threadId, keys, threadLog, logEqual) ?? noLines;
}

/** Above this many lines the log mounts only those near the viewport. */
const virtualAbove = 200;
/** 12px mono on 20px rows. */
const lineHeight = 20;
const lineKey = (line: LogLine) => line.key;

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const formatTime = (at: number) => time.format(at);

export default function LogsTabView(props: TabViewProps) {
  const scope = parseLogScope(props.tab.id);
  return (
    <WithServices>
      {scope.kind === "daemon" ? (
        <DaemonLog {...props} />
      ) : (
        <ThreadLogView {...props} agentId={scope.kind === "agent" ? scope.agentId : undefined} />
      )}
    </WithServices>
  );
}

/** The thread's log, or one agent's: filters, Find-as-you-type, follow, copy and save. */
function ThreadLogView(props: TabViewProps & { agentId: string | undefined }) {
  const { scope: threadId, tab, agentId } = props;
  const lines = useThreadLog(threadId);
  const agents = useThreadAgents(threadId);
  const actions = useWorkspaceActions(threadId);
  const services = usePanelServices();
  const toast = useToast();
  const clearedByThread = useLocal(services.logCleared, (value) => value);
  const cleared = clearedByThread.get(threadId);
  const filter = readFilter(tab.data);
  const [query, setQuery] = useState("");
  const agent = agentId ? agents.find((each) => each.id === agentId) : undefined;
  const subtree = useMemo(
    () => (agentId ? agentSubtree(agents, agentId) : undefined),
    [agents, agentId],
  );
  // An agent's tab is titled with its name once known.
  const agentName = agent?.name;
  useEffect(() => {
    if (agentName && tab.title !== `${agentName} log`)
      actions.update(tab.key, { title: `${agentName} log` });
  }, [agentName, tab.title, tab.key, actions]);
  const kept = cleared === undefined ? lines : lines.filter((line) => !cleared.has(line.key));
  const scoped = subtree ? kept.filter((line) => line.agentId && subtree.has(line.agentId)) : kept;
  const shown = filterLog(scoped, filter, query);
  const hidden = lines.length - kept.length;
  const setFilter = (next: LogFilter) => actions.update(tab.key, { data: next });
  const filtered = shown.length !== scoped.length;
  const text = () => formatLog(shown, formatTime);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 pr-2 pl-1.5 shadow-[inset_0_-1px_0_var(--border)]">
        <ScopeMenu threadId={threadId} tab={tab} agents={agents} />
        <label className="relative ml-1 flex h-7 w-48 min-w-24 shrink items-center">
          <MagnifyingGlassIcon
            aria-hidden
            size={14}
            className="pointer-events-none absolute left-2 text-subtle-foreground"
          />
          <input
            type="search"
            aria-label="Filter lines"
            placeholder="Filter lines"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            className="h-7 w-full rounded-md bg-secondary pr-2 pl-7 text-ui text-foreground outline-none placeholder:text-subtle-foreground focus-visible:shadow-[0_0_0_2px_var(--tint-line)]"
          />
        </label>
        <FilterMenus filter={filter} onChange={setFilter} />
        <span className="flex-1" />
        <span role="status" className="shrink-0 px-1 text-xs tabular-nums text-subtle-foreground">
          {filtered ? `${shown.length} of ${scoped.length}` : `${scoped.length}`}{" "}
          {scoped.length === 1 ? "line" : "lines"}
        </span>
        <ToolbarButton
          icon={CopyIcon}
          label="Copy lines"
          disabled={!shown.length}
          onClick={() =>
            void navigator.clipboard?.writeText(text()).then(
              () => toast.add({ title: `Copied ${shown.length} lines` }),
              () => toast.add({ title: "Couldn't copy", description: "Allow clipboard access." }),
            )
          }
        />
        <ToolbarButton
          icon={DownloadSimpleIcon}
          label="Save as a file"
          disabled={!shown.length}
          onClick={() => save(`${agentName ?? "thread"}-${threadId}.log`, text())}
        />
      </div>
      {hidden > 0 && (
        <p className="flex h-8 shrink-0 items-center gap-1 px-3 text-xs text-subtle-foreground">
          {hidden} earlier {hidden === 1 ? "line" : "lines"} cleared ·{" "}
          <button
            type="button"
            className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:shadow-[0_0_0_2px_var(--ring)]"
            onClick={() => showLogLines(services.logCleared, threadId)}
          >
            Show
          </button>
        </p>
      )}
      {!scoped.length ? (
        <EmptyState
          icon={ScrollIcon}
          title={agentId ? "Nothing logged for this agent yet" : "No logs yet"}
          description={
            agentId
              ? "Its turns, commands, background work and questions appear here, with its subagents'."
              : "Sessions, subagents, background work and provider notices for this thread appear here."
          }
        />
      ) : !shown.length ? (
        <EmptyState
          icon={MagnifyingGlassIcon}
          title="No lines match"
          description="Change the filter or the levels and sources shown."
        />
      ) : (
        <FollowedLines lines={shown} label={agentName ? `${agentName} log` : "Thread log"} />
      )}
    </div>
  );
}

/** Save text as a file through the browser's download. */
function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[^\w.-]+/g, "-");
  link.click();
  // The download has its own copy once started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The lines, newest at the bottom, following new ones while scrolled to the end. Scrolling up
 * pauses following; a pill offers to jump back down and says how many arrived meanwhile.
 */
function FollowedLines(props: { lines: readonly LogLine[]; label: string }) {
  const { lines } = props;
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [seen, setSeen] = useState(lines.length);
  const count = lines.length;
  useLayoutEffect(() => {
    const element = box.current;
    // Each new line scrolls to the end while following.
    if (follow && element && count) element.scrollTop = element.scrollHeight;
  }, [count, follow]);
  const unseen = follow ? 0 : Math.max(0, lines.length - seen);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={box}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          if (atEnd !== follow) {
            setFollow(atEnd);
            setSeen(lines.length);
          }
        }}
        className="h-full overflow-auto px-3 pt-2 pb-3 font-mono text-[12px] leading-5"
      >
        <div role="list" aria-label={props.label} className="text-muted-foreground">
          <LongRows
            items={lines}
            virtualAbove={virtualAbove}
            rowKey={lineKey}
            estimate={lineHeight}
            render={(line) => <LogRow line={line} />}
          />
        </div>
      </div>
      {!follow && (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover px-3 text-xs text-foreground shadow-[var(--glass-shadow)] outline-none hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)]"
        >
          <ArrowLineDownIcon aria-hidden size={13} />
          {unseen ? `${unseen} new ${unseen === 1 ? "line" : "lines"}` : "Follow new lines"}
        </button>
      )}
    </div>
  );
}

function LogRow(props: { line: LogLine }) {
  const { line } = props;
  return (
    <div role="listitem" className="grid min-h-5 grid-cols-[auto_8ch_minmax(0,1fr)] gap-x-3">
      <span className="text-subtle-foreground tabular-nums">{formatTime(line.at)}</span>
      {/* Warnings and errors share the failed colour (the design's Logs); amber stays
          reserved for "needs you". */}
      <span className={cn(line.level !== "info" && "text-status-failed")}>
        {line.level === "info" ? line.source : line.level === "warn" ? "warn" : "error"}
      </span>
      <span className="break-words whitespace-pre-wrap">{line.text}</span>
    </div>
  );
}

/** Clear, beside a Logs tab: hides the lines shown so far (Show brings them back). */
export function LogsActions(props: TabViewProps) {
  if (parseLogScope(props.tab.id).kind === "daemon") return null;
  return (
    <WithServices quiet>
      <LogsButtons threadId={props.scope} />
    </WithServices>
  );
}

function LogsButtons(props: { threadId: string }) {
  const services = usePanelServices();
  const lines = useThreadLog(props.threadId);
  return (
    <ToolbarButton
      icon={TrashIcon}
      label="Clear logs"
      disabled={!lines.length}
      onClick={() =>
        hideLogLines(
          services.logCleared,
          props.threadId,
          lines.map((line) => line.key),
        )
      }
    />
  );
}
