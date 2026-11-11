import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectStorage } from "../project-storage.ts";
import { Store } from "../store.ts";
import { TargetThreads } from "./target-threads.ts";

const opened: { store: Store; home: string; threads: TargetThreads }[] = [];
afterEach(async () => {
  for (const { store, home, threads } of opened.splice(0)) {
    threads.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
function machine() {
  const home = mkdtempSync(join(tmpdir(), "ace-target-projects-"));
  const store = new Store(join(home, "events.sqlite"));
  const threads = new TargetThreads({
    store,
    engine: () => undefined,
    journal: () => undefined,
    now: () => 1000,
    limit: () => undefined,
    schedule: () => () => {},
    report: (error) => {
      throw error;
    },
  });
  opened.push({ store, home, threads });
  return { store, home, threads, catalog: new ProjectStorage(store, () => 1000) };
}

test("other machines never see or reach Spade's project or a chat's folder", () => {
  const { store, home, threads, catalog } = machine();
  const repo = store.createWorkspace(join(home, "repo"), "Repo");
  catalog.registerSpade(join(home, "spade", "workspace"));
  catalog.registerChat(join(home, "chats", "one"), "A chat");
  expect(threads.projects()).toEqual([{ workspaceId: repo, name: "Repo" }]);
  expect(() => threads.project("Spade")).toThrow('No project "Spade" on this machine.');
  // The one project the person has is still the default when none is named.
  expect(threads.project(undefined)).toBe(repo);
});
