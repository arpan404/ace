import type { ThreadKey, ThreadReader } from "@ace/client";
import { useTaskIds, useThread } from "@ace/client-react";
import type { BackgroundTask } from "@ace/protocol";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useVersion } from "../store.ts";
import type { TerminalInfo } from "../sources.ts";
import type { TerminalSessions } from "./sessions.ts";

const readShells = (reader: ThreadReader) =>
  reader.taskIds().flatMap((id) => {
    const task = reader.task(id);
    return task && task.kind === "shell" && !task.ambient ? [task] : [];
  });
const sameTasks = (a: readonly BackgroundTask[], b: readonly BackgroundTask[]) =>
  a.length === b.length && a.every((task, i) => task === b[i]);
const noTasks: readonly BackgroundTask[] = [];

/** The agents' background shells in a thread, live (helpers that never hold it open excluded). */
export function useBackgroundShells(threadId: string): readonly BackgroundTask[] {
  const ids = useTaskIds(threadId);
  const keys = useMemo<ThreadKey[]>(
    () => ["tasks", ...(ids ?? []).map((id): ThreadKey => `task:${id}`)],
    [ids],
  );
  return useThread(threadId, keys, readShells, sameTasks) ?? noTasks;
}

/** The thread's PTYs as the daemon last listed them, whether they have been read, and the link. */
export function useThreadTerminals(sessions: TerminalSessions, threadId: string) {
  const source = sessions.source;
  const version = useVersion(source);
  // `version` changes whenever the list does, so the list is re-read only then. It is read in
  // the body so React Compiler keeps it as a dependency too.
  const list = useMemo<readonly TerminalInfo[]>(
    () => (version >= 0 ? source.list(threadId) : []),
    [source, threadId, version],
  );
  return {
    list,
    listed: version >= 0 && source.listed(threadId),
    link: version >= 0 ? source.link : "disconnected",
  };
}

/** A terminal's exit code once its shell has exited, else null. */
export function useExitCode(sessions: TerminalSessions, id: string): number | null {
  const subscribe = useCallback(
    (changed: () => void) => sessions.watch(id, changed),
    [sessions, id],
  );
  return useSyncExternalStore(subscribe, () => sessions.exitCode(id));
}

/** Two entries never read the same: a repeated label gets " 2", " 3"... in order. */
export function distinctLabels<T extends { label: string }>(entries: readonly T[]): T[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = (seen.get(entry.label) ?? 0) + 1;
    seen.set(entry.label, count);
    return count === 1 ? entry : { ...entry, label: `${entry.label} ${count}` };
  });
}
