import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTask, BackgroundTaskId, type EventPayload } from "@ace/protocol";
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
const started = (task: BackgroundTask): EventPayload => ({ type: "background_task.started", task });
const ended = (id: string): EventPayload => ({
  type: "background_task.updated",
  taskId: BackgroundTaskId.parse(id),
  status: "completed",
  endedAt: 2,
});

/** A store on disk with one thread, which the test can take back to an older build's shape. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ace-watching-count-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  cleanup.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  return {
    append: (payloads: EventPayload[]) => store.appendEvents(thread.id, payloads),
    live: () => store.getThread(thread.id)?.live,
    /** As an older build left it: no count, and the one-time seed not yet run; then start again. */
    restartFromOlderBuild() {
      store.atomic((db) => {
        db.prepare(
          "UPDATE threads SET client=json_remove(client,'$.live.watchingCount') WHERE id=?",
        ).run(thread.id);
        db.exec("DELETE FROM client_thread_migration WHERE id=3");
      });
      expect(store.getThread(thread.id)?.live?.watchingCount).toBeUndefined();
      store.close();
      store = new Store(path);
    },
  };
}

it("a thread stored before the exact count gets it from its running shells on the next start", () => {
  const f = fixture();
  f.append([
    ...Array.from({ length: 9 }, (_, at) => started(shell(`shell-${at}`, `bun run job-${at}`))),
    // A helper that never holds the thread open, and a shell that already ended: not counted.
    started(shell("lsp", "tsserver", true)),
    started(shell("done", "bun run build")),
    ended("done"),
  ]);
  expect(f.live()?.watchingCount).toBe(9);

  f.restartFromOlderBuild();
  expect(f.live()?.watchingCount).toBe(9);
  // The names list lost one for good when the build pushed it out and then ended: only the
  // count still says nine.
  expect(f.live()?.watching).toHaveLength(7);
});

it("a shell titled only with tabs, newlines or spaces is neither seeded nor left behind", () => {
  const f = fixture();
  f.append([
    started(shell("tabs", "\t\n")),
    started(shell("spaces", "  \t ")),
    started(shell("relay", "bun run dev:relay")),
  ]);
  expect(f.live()?.watchingCount).toBe(1);

  f.restartFromOlderBuild();
  expect(f.live()?.watchingCount).toBe(1);
  f.append([ended("tabs"), ended("spaces")]);
  expect(f.live()?.watchingCount).toBe(1);
  f.append([ended("relay")]);
  expect(f.live()?.watchingCount).toBeUndefined();
});
