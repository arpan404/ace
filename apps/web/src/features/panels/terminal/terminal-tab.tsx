import type { ThreadKey, ThreadReader } from "@ace/client";
import { useItem, useTaskIds, useThread } from "@ace/client-react";
import type { BackgroundTask } from "@ace/protocol";
import { TerminalWindowIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { usePanelServices } from "../services.ts";
import { useVersion } from "../store.ts";
import { TerminalScreen } from "./screen.ts";
import type { TerminalSessions } from "./sessions.ts";
import { ScreenRows, TerminalView } from "./terminal-view.tsx";

/** "bun run dev:relay" → "dev:relay"; "cargo watch -x test" → "cargo". */
export function shellLabel(command: string): string {
  const script = /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(\S+)/.exec(command.trim());
  if (script?.[1]) return script[1];
  return command.trim().split(/\s+/)[0]?.split("/").pop() || command;
}

const readShells = (reader: ThreadReader) =>
  reader.taskIds().flatMap((id) => {
    const task = reader.task(id);
    return task && task.kind === "shell" && !task.ambient ? [task] : [];
  });
const sameTasks = (a: readonly BackgroundTask[], b: readonly BackgroundTask[]) =>
  a.length === b.length && a.every((task, i) => task === b[i]);

/** The agents' background shells in a thread, live. */
function useBackgroundShells(threadId: string): readonly BackgroundTask[] {
  const ids = useTaskIds(threadId);
  const keys = useMemo<ThreadKey[]>(
    () => ["tasks", ...(ids ?? []).map((id): ThreadKey => `task:${id}`)],
    [ids],
  );
  return useThread(threadId, keys, readShells, sameTasks) ?? [];
}

function useTerminalList(sessions: TerminalSessions, threadId: string) {
  const source = sessions.source;
  const version = useVersion(source);
  // `version` changes whenever the list does, so the list is re-read only then. It is read in
  // the body so React Compiler keeps it as a dependency too.
  const list = useMemo(
    () => (version >= 0 ? source.list(threadId) : []),
    [source, threadId, version],
  );
  const selected = useSyncExternalStore(sessions.watchSelection, () =>
    sessions.selection(threadId),
  );
  return { list, selected, link: source.link };
}

/** Opens a terminal in the thread's checkout and shows it. */
export function useOpenTerminal(threadId: string) {
  const { terminals } = usePanelServices();
  const link = useVersion(terminals.source) >= 0 ? terminals.source.link : "disconnected";
  const [error, setError] = useState<string>();
  const open = useCallback(() => {
    setError(undefined);
    terminals.open(threadId).catch(() => setError("Couldn't open a terminal."));
  }, [terminals, threadId]);
  return { open, error, ready: link === "connected" };
}

/** Terminal tab: the agents' background shells and your own terminals, each in its own tab. */
export function TerminalTab(props: { threadId: string }) {
  const { threadId } = props;
  const { terminals: sessions } = usePanelServices();
  const shells = useBackgroundShells(threadId);
  const { list, selected, link } = useTerminalList(sessions, threadId);
  const [closeError, setCloseError] = useState<string>();
  const opener = useOpenTerminal(threadId);
  const tabs = [
    ...shells.map((task) => ({
      id: `task:${task.id}`,
      label: shellLabel(task.title),
      live: task.status === "running",
      closable: false,
    })),
    ...list.map((info) => ({ id: info.id, label: info.name, live: false, closable: true })),
  ];
  const active = tabs.find((tab) => tab.id === selected) ?? tabs[0];
  // Remember which tab is showing (not chosen), so Clear acts on it.
  const shown = active?.id;
  useEffect(() => sessions.show(threadId, shown), [sessions, threadId, shown]);
  if (!tabs.length)
    return (
      <EmptyState
        icon={TerminalWindowIcon}
        title="No terminals"
        description="Open a terminal in this thread's checkout, or watch the agents' background shells here."
        action={
          opener.ready ? (
            <Button size="sm" onClick={opener.open}>
              New terminal
            </Button>
          ) : undefined
        }
      />
    );
  const shell = shells.find((task) => `task:${task.id}` === active?.id);
  const pty = list.find((info) => info.id === active?.id);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Terminals" className="flex items-center gap-0.5 px-2 pt-1.5">
        {tabs.map((tab) => (
          <span key={tab.id} className="group/tt relative inline-flex">
            <button
              type="button"
              role="tab"
              aria-label={tab.live ? `${tab.label}, running` : tab.label}
              aria-selected={tab.id === active?.id}
              onClick={() => sessions.select(threadId, tab.id)}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-sm px-[9px] font-mono text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground",
                tab.id === active?.id &&
                  "bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] text-foreground",
                tab.closable && "group-hover/tt:pr-6",
              )}
            >
              {tab.live && (
                <span aria-hidden className="size-[5px] rounded-full bg-status-working" />
              )}
              {tab.label}
            </button>
            {tab.closable && (
              <button
                type="button"
                aria-label={`Close ${tab.label}`}
                onClick={() => {
                  setCloseError(undefined);
                  sessions.close(tab.id).catch(() => setCloseError(`Couldn't close ${tab.label}.`));
                }}
                className="absolute top-1 right-1 hidden size-4 place-items-center rounded-[4px] text-subtle-foreground group-hover/tt:grid hover:bg-accent hover:text-foreground focus-visible:grid"
              >
                <XIcon aria-hidden size={10} />
              </button>
            )}
          </span>
        ))}
      </div>
      {link === "disconnected" && (
        <p
          role="status"
          className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground"
        >
          <Spinner /> Reconnecting to the terminal…
        </p>
      )}
      {(opener.error ?? closeError) && (
        <p role="alert" className="px-4 pt-2 text-xs text-status-failed">
          {opener.error ?? closeError}
        </p>
      )}
      {shell && <BackgroundShell threadId={threadId} task={shell} />}
      {pty && <TerminalView key={pty.id} sessions={sessions} id={pty.id} name={pty.name} />}
    </div>
  );
}

/** A background shell's output as the agent's tool call reports it (read-only). */
function BackgroundShell(props: { threadId: string; task: BackgroundTask }) {
  const item = useItem(props.threadId, props.task.toolCallId ?? "");
  const tail =
    item?.type === "tool_call" && item.call.detail.kind === "shell"
      ? (item.call.detail.output?.tail ?? "")
      : "";
  const truncated =
    item?.type === "tool_call" &&
    item.call.detail.kind === "shell" &&
    item.call.detail.output?.truncated;
  const rows = useMemo(() => {
    const screen = new TerminalScreen();
    screen.write(tail.replace(/(?<!\r)\n/g, "\r\n"));
    return screen.rows();
  }, [tail]);
  return (
    <>
      {truncated && (
        <p className="px-4 pt-2 font-sans text-xs text-subtle-foreground">
          Showing the latest output.
        </p>
      )}
      <ScreenRows rows={rows} label={`${shellLabel(props.task.title)} output`} />
    </>
  );
}
