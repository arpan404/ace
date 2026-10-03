import type { FileChange } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon } from "../daemon.ts";
import { ScenarioPlayer } from "../scenario.ts";
import { devWorld } from "../scenarios/dev-world.ts";

/** A file an agent changed in one thread's worktree, with every change it received, in order. */
export interface FakeChangedFile {
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  path: string;
  /** The changes as the thread's tool calls carry them; diffs and stats are the client's. */
  changes: FileChange[];
  updatedAt: number;
  /** Current contents, served for a download ("" once deleted or when only a patch is known). */
  text: string;
}

/**
 * Files changed across threads, newest thread first. Derived from the development world's own
 * tool calls, so More › Files lists exactly what each thread's Changes tab shows.
 */
export function changedFiles(now: number): FakeChangedFile[] {
  const daemon = new FakeDaemon({ clock: () => now });
  const world = devWorld();
  for (const thread of world) {
    const player = new ScenarioPlayer(daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else player.runUntilBlocked();
  }
  return world
    .flatMap((thread) => threadFiles(daemon, thread.scenario.thread.id))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

function threadFiles(daemon: FakeDaemon, threadId: string): FakeChangedFile[] {
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  if (view?.kind !== "thread") return [];
  const byPath = new Map<string, FakeChangedFile>();
  for (const id of view.itemOrder) {
    const item = view.items[id];
    if (item?.type !== "tool_call") continue;
    const detail = item.call.detail;
    if (!("changes" in detail)) continue;
    for (const change of detail.changes) {
      const path = change.kind === "move" && change.movePath ? change.movePath : change.path;
      const file = byPath.get(path) ?? {
        threadId,
        threadTitle: view.thread.title,
        workspaceId: view.thread.workspaceId,
        path,
        changes: [],
        updatedAt: 0,
        text: "",
      };
      file.changes.push(change);
      file.updatedAt = Math.max(file.updatedAt, item.call.endedAt ?? item.call.startedAt);
      file.text = change.kind === "delete" ? "" : (change.newText ?? file.text);
      byPath.set(path, file);
    }
  }
  return [...byPath.values()];
}
