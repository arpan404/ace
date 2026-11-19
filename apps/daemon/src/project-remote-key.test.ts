import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import { ProjectStorage } from "./project-storage.ts";
import { RemoteKeyReader } from "./project-remote-key-reader.ts";
import { pageQuery } from "./project-remote-key.ts";
import { Store } from "./store.ts";

const ace = "github.com/arpan/ace";
const fork = "github.com/someone/ace";
const P = "11111111-1111-4111-8111-111111111111";

type Facts = { remotes: string[]; subpath: string } | undefined | Error;

/** A daemon's registrations over a real store, with Git's answers set per folder. */
async function daemon(options: { batch?: number; pageSize?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-remote-key-")));
  let clock = 1_000;
  const now = () => clock;
  let minted = 0;
  const store = new Store(join(root, "events.sqlite"), undefined, { now });
  const catalog = new ProjectStorage(
    store,
    now,
    () => `00000000-0000-4000-8000-${String(++minted).padStart(12, "0")}`,
  );
  const git = new Map<string, Facts>();
  const reads: string[] = [];
  let reading = 0;
  let widest = 0;
  const announced: WorkspaceId[] = [];
  const reader = new RemoteKeyReader({
    atomic: (work) => store.atomic(work),
    read: async (path) => {
      reads.push(path);
      widest = Math.max(widest, ++reading);
      await Promise.resolve();
      reading--;
      const facts = git.get(path);
      if (facts instanceof Error) throw facts;
      return facts;
    },
    announce: (id) => announced.push(id),
    now,
    wait: () => Promise.resolve(),
    ttlMs: 60_000,
    ...(options.batch ? { batch: options.batch } : {}),
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
  });
  onTestFinished(async () => {
    reader.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    catalog,
    reader,
    reads,
    announced,
    git,
    widest: () => widest,
    later: (ms: number) => {
      clock += ms;
    },
    async add(folder: string, facts: Facts) {
      const path = join(root, folder);
      await mkdir(path, { recursive: true });
      git.set(path, facts);
      return catalog.register(path, folder);
    },
  };
}

test("a checkout's remotes and folder are reported once read, and clients are told once", async () => {
  const home = await daemon();
  const app = await home.add("app", { remotes: [ace, fork], subpath: "apps/web" });
  const notes = await home.add("notes", undefined);
  expect(home.catalog.get(app.id).remoteKey).toBeUndefined();
  await home.reader.poke();
  expect(home.catalog.get(app.id).remoteKey).toEqual({
    remotes: [ace, fork],
    subpath: "apps/web",
  });
  // A folder outside Git has nothing to group by, and nothing changed for its clients.
  expect(home.catalog.get(notes.id).remoteKey).toBeUndefined();
  expect(home.announced).toEqual([app.id]);
  // Fresh reads aren't repeated by the next client.
  await home.reader.poke();
  expect(home.reads).toHaveLength(2);
});

test("a stale key is read again, and only a changed one is announced", async () => {
  const home = await daemon();
  const app = await home.add("app", { remotes: [ace], subpath: "" });
  const same = await home.add("same", { remotes: [ace], subpath: "" });
  await home.reader.poke();
  home.announced.length = 0;
  home.later(60_001);
  home.git.set(home.catalog.get(app.id).path, { remotes: [fork], subpath: "" });
  await home.reader.poke();
  expect(home.reads).toHaveLength(4);
  expect(home.catalog.get(app.id).remoteKey?.remotes).toEqual([fork]);
  expect(home.catalog.get(same.id).remoteKey?.remotes).toEqual([ace]);
  expect(home.announced).toEqual([app.id]);
});

test("a checkout the person unlinked never reports a key again, even after a link", async () => {
  const home = await daemon();
  const app = await home.add("app", { remotes: [ace], subpath: "" });
  await home.reader.poke();
  home.catalog.unlink(app.id);
  expect(home.catalog.get(app.id).remoteKey).toBeUndefined();
  home.later(60_001);
  home.git.set(home.catalog.get(app.id).path, { remotes: [fork], subpath: "" });
  home.announced.length = 0;
  await home.reader.poke();
  expect(home.catalog.get(app.id).remoteKey).toBeUndefined();
  expect(home.announced).toEqual([]);
  // A link puts it in a group by its identity, not back into remote grouping.
  home.catalog.link(app.id, P);
  expect(home.catalog.get(app.id)).toMatchObject({ identity: { id: P } });
  expect(home.catalog.get(app.id).remoteKey).toBeUndefined();
});

test("a failed read keeps the last key and waits as long as a good one before Git is asked again", async () => {
  const home = await daemon();
  const app = await home.add("app", { remotes: [ace], subpath: "" });
  await home.reader.poke();
  home.later(60_001);
  home.git.set(home.catalog.get(app.id).path, new Error("git timed out"));
  await home.reader.poke();
  expect(home.catalog.get(app.id).remoteKey?.remotes).toEqual([ace]);
  await home.reader.poke();
  expect(home.reads).toHaveLength(2);
});

test("a sweep reads a few registrations at a time, never ones removed or chats", async () => {
  const home = await daemon({ batch: 3 });
  const added = [];
  for (let index = 0; index < 10; index++)
    added.push(await home.add(`p${index}`, { remotes: [`host/r${index}`], subpath: "" }));
  const gone = added[0]!;
  home.catalog.forget(gone.id);
  home.catalog.registerChat(join(home.catalog.get(added[1]!.id).path, "..", "chat"), "Chat");
  await home.reader.poke();
  expect(home.widest()).toBeLessThanOrEqual(3);
  expect(home.reads).toHaveLength(9);
  expect(home.reads).not.toContain(gone.path);
});

test("a sweep walks every registration in pages, reading each due one once", async () => {
  const home = await daemon({ pageSize: 4 });
  const added = [];
  for (let index = 0; index < 11; index++)
    added.push(await home.add(`p${index}`, { remotes: [`host/r${index}`], subpath: "" }));
  await home.reader.poke();
  expect(home.reads.toSorted()).toEqual(added.map((each) => each.path).toSorted());
  expect(added.every((each) => home.catalog.get(each.id).remoteKey !== undefined)).toBe(true);
});

test("each page of the walk is a range read on the primary key: no table scan, no sort", async () => {
  const home = await daemon();
  for (let index = 0; index < 3; index++)
    await home.add(`p${index}`, { remotes: [ace], subpath: "" });
  const plan = home.store
    .atomic((db) => db.prepare(`EXPLAIN QUERY PLAN ${pageQuery}`).all("", 64))
    .map((row) => String(row.detail));
  expect(
    plan.some((step) =>
      /SEARCH w USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex_workspaces)/.test(step),
    ),
  ).toBe(true);
  expect(plan.filter((step) => /^SCAN|TEMP B-TREE/.test(step))).toEqual([]);
});

test("remotes on this machine's own disk never group checkouts on two machines", async () => {
  const home = await daemon();
  const mirror = await home.add("mirror", {
    remotes: ["/srv/git/app.git", "C:\\repos\\app"],
    subpath: "",
  });
  const mixed = await home.add("mixed", { remotes: [ace, "/srv/git/ace.git"], subpath: "" });
  await home.reader.poke();
  expect(home.catalog.get(mirror.id).remoteKey).toBeUndefined();
  expect(home.catalog.get(mixed.id).remoteKey).toEqual({ remotes: [ace], subpath: "" });
});
