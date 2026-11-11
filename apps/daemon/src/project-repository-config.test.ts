import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { Thread, type ForgeRepository, type WorkspaceChanged } from "@ace/protocol";
import { migrateEngine } from "./engine/migrations.ts";
import { ProjectRepositoryConfigs } from "./project-repository-config.ts";
import { ProjectStorage } from "./project-storage.ts";
import { Store } from "./store.ts";

const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "app" };
const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "app" };

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-project-repositories-"));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  store.atomic((db) => migrateEngine(db));
  const workspaceId = store.createWorkspace(join(home, "app"), "App");
  onTestFinished(async () => {
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    workspaceId,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(path);
      return new ProjectRepositoryConfigs(store);
    },
  };
}

test("a project's repository choices survive a restart", async () => {
  const f = await setup();
  new ProjectRepositoryConfigs(f.store).set(f.workspaceId, {
    added: [gitlab],
    hidden: [],
    primary: gitlab,
  });
  expect(f.restart().get(f.workspaceId)).toEqual({ added: [gitlab], hidden: [], primary: gitlab });
});

test("a project that never chose, or cleared its choices, has none", async () => {
  const f = await setup();
  const configs = new ProjectRepositoryConfigs(f.store);
  expect(configs.get(f.workspaceId)).toBeUndefined();
  configs.set(f.workspaceId, { added: [], hidden: [github], primary: null });
  configs.set(f.workspaceId, null);
  expect(configs.get(f.workspaceId)).toBeUndefined();
  configs.set(f.workspaceId, { added: [], hidden: [], primary: null });
  expect(configs.get(f.workspaceId)).toBeUndefined();
});

test("a primary that is also hidden is refused and the saved choices stay", async () => {
  const f = await setup();
  const configs = new ProjectRepositoryConfigs(f.store);
  configs.set(f.workspaceId, { added: [gitlab], hidden: [], primary: null });
  expect(() =>
    configs.set(f.workspaceId, { added: [], hidden: [github], primary: github }),
  ).toThrow("primary_hidden");
  expect(configs.get(f.workspaceId)).toEqual({ added: [gitlab], hidden: [], primary: null });
});

test("a saved value that no longer reads as choices is treated as none", async () => {
  const f = await setup();
  f.store
    .statement("INSERT INTO workspace_metadata(workspace_id,repositories) VALUES (?,?)")
    .run(f.workspaceId, JSON.stringify({ added: "not a list" }));
  expect(new ProjectRepositoryConfigs(f.store).get(f.workspaceId)).toBeUndefined();
});

test("a thread's worktree finds its project's choices, as the project's own folder does", async () => {
  const f = await setup();
  const configs = new ProjectRepositoryConfigs(f.store);
  configs.set(f.workspaceId, { added: [], hidden: [github], primary: null });
  const thread = Thread.parse({
    id: "repositories-thread",
    workspaceId: f.workspaceId,
    provider: "codex",
    title: "Work",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const worktree = join(f.home, "worktrees", "work");
  f.store
    .statement("INSERT INTO engine_sessions(thread_id,cwd) VALUES (?,?)")
    .run(thread.id, worktree);
  const expected = { added: [], hidden: [github], primary: null };
  expect(configs.forCheckout(join(f.home, "app"))).toEqual(expected);
  expect(configs.forCheckout(worktree)).toEqual(expected);
  expect(configs.forCheckout(join(f.home, "elsewhere"))).toBeUndefined();
});

test("saving a project's choices tells every client the project changed", async () => {
  const f = await setup();
  const projects = new ProjectStorage(f.store, () => 5);
  const changes: WorkspaceChanged[] = [];
  projects.subscribe((change) => changes.push(change));
  projects.setRepositories(f.workspaceId, { added: [gitlab], hidden: [], primary: null });
  expect(changes).toEqual([
    expect.objectContaining({ change: "updated", workspaceId: f.workspaceId }),
  ]);
  expect(new ProjectRepositoryConfigs(f.store).get(f.workspaceId)?.added).toEqual([gitlab]);
});

test("a save that started from choices another device has since replaced is refused", async () => {
  const f = await setup();
  const configs = new ProjectRepositoryConfigs(f.store);
  // The web hides GitHub, then the phone, which read the project before that, adds GitLab.
  configs.set(f.workspaceId, { added: [], hidden: [github], primary: null }, null);
  expect(() =>
    configs.set(f.workspaceId, { added: [gitlab], hidden: [], primary: null }, null),
  ).toThrow("repositories_changed");
  expect(configs.get(f.workspaceId)).toEqual({ added: [], hidden: [github], primary: null });
  // Read again and applied to what is saved now, the phone's edit keeps the web's.
  const upper = { ...github, owner: "ACME" };
  configs.set(
    f.workspaceId,
    { added: [gitlab], hidden: [github], primary: null },
    { added: [], hidden: [upper], primary: null },
  );
  expect(configs.get(f.workspaceId)).toEqual({ added: [gitlab], hidden: [github], primary: null });
});
