import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Thread } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { FilesWorkspaces } from "./files-workspaces.ts";
import { Store } from "./store.ts";

// A Git discard moves untracked files to Recently deleted through the thread's files service.
// The path is relative to the checkout Git holds, so the service must be rooted exactly there.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

it("hands out the files service only for the checkout the thread runs in", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-files-pinned-")));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const checkout = join(home, "checkout");
  const other = join(home, "other");
  await mkdir(checkout);
  await mkdir(other);
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspaceId = store.createWorkspace(checkout, "Checkout");
  const thread = Thread.parse({
    id: "thread-pinned",
    workspaceId,
    provider: "codex",
    title: "Pinned",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  let counter = 0;
  const files = new FilesWorkspaces({
    store,
    options: {},
    now: () => 1,
    id: () => `pinned-${++counter}`,
    config: {
      dataDir: join(home, "data"),
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
  });
  cleanup.push(() => files.close());

  await expect(files.acquireAt(thread.id, other)).rejects.toThrow("git_trash_unavailable");
  const acquired = await files.acquireAt(thread.id, checkout);
  acquired.release();
});
