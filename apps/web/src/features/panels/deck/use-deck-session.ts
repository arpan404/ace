import { useClient, useConnectionState } from "@ace/client-react";
import { useThreadField } from "@ace/client-react/thread-field";
import { providerDisplayName, type Turn } from "@ace/ui-core";
import type { EditorLayout } from "@ace/ui-core/editor-workbench";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BufferRegistry } from "@/features/editor-workbench/index.ts";
import type { DeckBuffers } from "@/features/editor-workbench/index.ts";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import { threadCheckoutRoot, threadProvider } from "@/lib/thread-fields.ts";
import { watchFolders } from "../files/folder-watch.ts";
import {
  editCallsOf,
  keepOpen,
  noChanges,
  recordChange,
  seeChanges,
  type AgentChanges,
} from "./agent-changes.ts";
import { openPaths } from "./deck-layout.ts";
import { authorOf, setEditCalls } from "./deck-registry.ts";

/*
 * A thread's Deck kept in step with its checkout (docs/editor/workbench.md 42–45, 54, 58): one
 * watch set for the folders of its open files; a changed folder, an ace file operation, a new
 * edit by the thread's agent or a reconnect makes the open buffers look at the disk again; the
 * turn's edit calls name who changed a file; and which open files an agent changed since the
 * person last looked.
 */

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Edits the thread's turns hold per path, to notice a new one. */
function editCounts(turns: readonly Turn[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const turn of turns)
    for (const edit of turn.edits)
      if (edit.call.status === "succeeded" && "changes" in edit.call.detail)
        for (const change of edit.call.detail.changes)
          for (const path of change.movePath ? [change.path, change.movePath] : [change.path])
            counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

export function useDeckSession(
  threadId: string,
  registry: BufferRegistry,
  buffers: DeckBuffers,
  layout: EditorLayout,
): { changes: AgentChanges; see(paths: Iterable<string>): void } {
  const client = useClient();
  const online = useConnectionState() === "ready";
  const paths = useMemo(() => openPaths(layout), [layout]);
  const pathKey = paths.join("\n");

  // One watch set: the folders of every open file (spec 58).
  const watch = useMemo(() => watchFolders(client, threadId), [client, threadId]);
  useEffect(() => () => watch.leave(), [watch]);
  useEffect(() => {
    watch.set(new Set(pathKey ? pathKey.split("\n").map(folderOf) : []));
  }, [watch, pathKey]);

  // The disk moved: a watched folder changed, an ace file operation, or the watcher fell behind.
  const open = useRef(paths);
  open.current = paths;
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type === "files.folders_changed" && message.threadId === threadId) {
          if (message.rescan) return registry.recheck(threadId);
          const folders = new Set(message.folders);
          for (const path of open.current)
            if (folders.has(folderOf(path))) registry.diskChanged({ root: threadId, path });
        } else if (message.type === "files.changed") {
          const { path, destination } = message.change;
          for (const each of [path, destination])
            if (each !== undefined && open.current.includes(each))
              registry.diskChanged({ root: threadId, path: each });
        }
      }),
    [client, registry, threadId],
  );

  // A reconnect: every open buffer checks its version again (spec 54), and the daemon hears the
  // watch set afresh.
  const wasOnline = useRef(online);
  useEffect(() => {
    const was = wasOnline.current;
    wasOnline.current = online;
    if (!online || was) return;
    watch.resume();
    registry.recheck(threadId);
  }, [online, registry, threadId, watch]);

  // Attribution reads this thread's edit calls (spec 45).
  const turns = useTurns(threadId);
  const checkout = useThreadField(threadId, threadCheckoutRoot);
  const provider = useThreadField(threadId, threadProvider);
  const firstSeen = useRef(new Map<string, number>());
  useEffect(() => {
    if (!checkout) return;
    const seen = firstSeen.current;
    const now = Date.now();
    const agent = provider ? providerDisplayName(provider) : "The agent";
    const calls = editCallsOf(turns, { threadId, threadTitle: "", agent }, (id) => {
      if (!seen.has(id)) seen.set(id, now);
      return seen.get(id) ?? now;
    });
    setEditCalls(threadId, { calls, checkout });
  }, [turns, checkout, provider, threadId]);
  useEffect(() => () => setEditCalls(threadId, undefined), [threadId]);

  // A new edit on an open file is a disk change too, should the watcher be slow to say so.
  const counts = useMemo(() => editCounts(turns), [turns]);
  const lastCounts = useRef(counts);
  useEffect(() => {
    const before = lastCounts.current;
    lastCounts.current = counts;
    for (const path of open.current)
      if ((counts.get(path) ?? 0) > (before.get(path) ?? 0))
        registry.diskChanged({ root: threadId, path });
  }, [counts, registry, threadId]);

  // Which open files someone changed on disk since the person looked (spec 21, 45).
  const [changes, setChanges] = useState<AgentChanges>(noChanges);
  useEffect(() => {
    const offs = (pathKey ? pathKey.split("\n") : []).map((path) => {
      const buffer = buffers.buffer(path);
      if (!buffer) return () => {};
      let clashed = buffer.snapshot().clash;
      return buffer.subscribe((event) => {
        if (event.type === "replaced" && event.reason === "reload")
          setChanges((current) =>
            recordChange(current, path, authorOf({ root: threadId, path }, Date.now())),
          );
        if (event.type !== "state") return;
        const clash = buffer.snapshot().clash;
        if (clash !== clashed && clash?.kind === "changed")
          setChanges((current) => recordChange(current, path, clash.by));
        clashed = clash;
      });
    });
    return () => {
      for (const off of offs) off();
    };
  }, [buffers, pathKey, threadId]);
  useEffect(() => setChanges((current) => keepOpen(current, paths)), [paths]);
  useEffect(() => buffers.setAgentMarks(changes), [buffers, changes]);

  return useMemo(
    () => ({ changes, see: (seen) => setChanges((current) => seeChanges(current, seen)) }),
    [changes],
  );
}
