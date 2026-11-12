import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTask, BackgroundTaskId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

const shell = (id: string, title: string, ambient = false) =>
  BackgroundTask.parse({
    id,
    agentId: "root",
    kind: "shell",
    title,
    status: "running",
    ambient,
    stoppable: true,
    startedAt: 1,
  });

it("a thread stored before the exact count gets it from its running shells on the next start", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-watching-count-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  cleanup.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  store.appendEvents(thread.id, [
    ...Array.from({ length: 9 }, (_, at) => ({
      type: "background_task.started" as const,
      task: shell(`shell-${at}`, `bun run job-${at}`),
    })),
    // A helper that never holds the thread open, and a shell that already ended: not counted.
    { type: "background_task.started", task: shell("lsp", "tsserver", true) },
    { type: "background_task.started", task: shell("done", "bun run build") },
    {
      type: "background_task.updated",
      taskId: BackgroundTaskId.parse("done"),
      status: "completed",
      endedAt: 2,
    },
  ]);
  expect(store.getThread(thread.id)?.live?.watchingCount).toBe(9);

  // As an older build left it: no count, and the one-time seed not yet run.
  store.atomic((db) => {
    db.prepare(
      "UPDATE threads SET client=json_remove(client,'$.live.watchingCount') WHERE id=?",
    ).run(thread.id);
    db.exec("DELETE FROM client_thread_migration WHERE id=3");
  });
  expect(store.getThread(thread.id)?.live?.watchingCount).toBeUndefined();
  store.close();
  store = new Store(path);

  expect(store.getThread(thread.id)?.live?.watchingCount).toBe(9);
  // The names list lost one for good when the build pushed it out and then ended: only the
  // count still says nine.
  expect(store.getThread(thread.id)?.live?.watching).toHaveLength(7);
});
