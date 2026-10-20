import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BrowserProjectForget } from "./browser-forget-projects.ts";
import { Store } from "./store.ts";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-forget-projects-"));
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace(home, "Test");
  const calls: { workspaceId: string; desktop: boolean }[] = [];
  const state = { desktop: false };
  const started: BrowserProjectForget[] = [];
  onTestFinished(async () => {
    for (const forget of started) await forget.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    workspace,
    calls,
    state,
    /** The daemon (re)starts with the browser service behind this port. */
    start() {
      const forget = new BrowserProjectForget(
        store,
        {
          forgetProject: async (workspaceId) => {
            calls.push({ workspaceId, desktop: state.desktop });
            return { desktop: state.desktop };
          },
        },
        (error) => {
          throw error;
        },
      );
      started.push(forget);
      return forget;
    },
  };
}

it("a project removed while the desktop is closed is purged there once it registers, across a restart", async () => {
  const f = await setup();
  await f.start().removed(f.workspace);
  // ace's Chrome forgets it at once; the desktop's purge is still owed.
  expect(f.calls).toEqual([{ workspaceId: f.workspace, desktop: false }]);

  const restarted = f.start();
  f.state.desktop = true;
  await restarted.flush();
  expect(f.calls.at(-1)).toEqual({ workspaceId: f.workspace, desktop: true });

  // Confirmed: the next desktop registration has nothing left to purge.
  await restarted.flush();
  expect(f.calls).toHaveLength(2);
});

it("a project added back before the desktop purged keeps the profile it uses again", async () => {
  const f = await setup();
  const forget = f.start();
  await forget.removed(f.workspace);
  forget.restored(f.workspace);

  f.state.desktop = true;
  await forget.flush();
  expect(f.calls).toEqual([{ workspaceId: f.workspace, desktop: false }]);
});
