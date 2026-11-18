import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  Command,
  Thread,
  type CommandPayload,
  type Project,
  type WorkspaceChanged,
  type WorkspaceId,
} from "@ace/protocol";
import { Projects } from "./projects.ts";
import { Store } from "./store.ts";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const refused = () => false;

/** One daemon's projects, over a real store in a temp folder. */
async function daemon(name = "daemon") {
  const root = await realpath(await mkdtemp(join(tmpdir(), `ace-identity-${name}-`)));
  const file = join(root, "events.sqlite");
  let minted = 0;
  // Each read of the clock is a moment later, so merges happen in order.
  let clock = 1000;
  const now = () => clock++;
  const mint = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, "0")}`;
  const open = () => {
    const store = new Store(file, undefined, { now });
    const projects = new Projects(store, now, {
      home: root,
      roots: async () => [root],
      identityId: mint,
    });
    return { store, projects };
  };
  let current = open();
  const changes: WorkspaceChanged[] = [];
  let stop = current.projects.subscribe((change) => changes.push(change));
  let sequence = 0;
  onTestFinished(async () => {
    stop();
    await current.projects.close();
    current.store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    changes,
    get store() {
      return current.store;
    },
    /** A project ace registers now: it starts its own logical project. */
    async add(folder: string): Promise<Project> {
      await mkdir(join(root, folder), { recursive: true });
      return current.projects.catalog.register(join(root, folder), folder);
    },
    /** A registration an older ace made: it has no identity. */
    legacy(folder: string): WorkspaceId {
      return current.store.createWorkspace(join(root, folder), folder);
    },
    get: (id: string) => current.projects.catalog.get(id as WorkspaceId),
    /** Spade's hidden project (ADR 0121). */
    spade(folder: string): WorkspaceId {
      return current.projects.catalog.registerSpade(join(root, folder));
    },
    command: (payload: CommandPayload, id = `command-${++sequence}`, allowed = () => true) =>
      current.projects.execute(Command.parse({ id, deviceId: "owner", payload }), allowed),
    thread(id: string, workspaceId: WorkspaceId) {
      const thread = Thread.parse({
        id,
        workspaceId,
        title: "Work",
        provider: "codex",
        status: { state: "done" },
        createdAt: 1000,
        updatedAt: 1000,
      });
      current.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    },
    async restart() {
      stop();
      await current.projects.close();
      current.store.close();
      current = open();
      stop = current.projects.subscribe((change) => changes.push(change));
    },
  };
}

test("an existing home keeps every registration and thread, each its own project, with no identity", async () => {
  const d = await daemon();
  const api = d.legacy("api");
  const web = d.legacy("web");
  d.thread("thread-api", api);
  await d.restart();
  expect(d.get(api)).toMatchObject({ id: api, name: "api", path: join(d.root, "api") });
  expect(d.get(api).identity).toBeUndefined();
  expect(d.get(web).identity).toBeUndefined();
  expect(d.store.getThread("thread-api" as never)?.workspaceId).toBe(api);
});

test("a project added now starts its own logical project, kept across a restart", async () => {
  const d = await daemon();
  const added = await d.add("api");
  expect(added.identity).toEqual({
    id: "00000000-0000-4000-8000-000000000001",
    aliases: [],
    source: "created",
  });
  await d.restart();
  expect(d.get(added.id).identity?.id).toBe("00000000-0000-4000-8000-000000000001");
});

test("linking puts one registration in a logical project and announces it", async () => {
  const d = await daemon();
  const legacy = d.legacy("api");
  const result = await d.command({
    type: "workspace.identity.link",
    workspaceId: legacy,
    identityId: P,
  });
  expect(result).toMatchObject({
    ok: true,
    workspace: { identity: { id: P, aliases: [], source: "linked" } },
  });
  expect(d.changes.at(-1)).toMatchObject({
    type: "workspace.changed",
    change: "updated",
    workspaceId: legacy,
    workspace: { identity: { id: P } },
  });
});

test("merging Q into P moves Q's registrations and keeps Q as P's alias", async () => {
  const d = await daemon();
  const p = d.legacy("p");
  const q1 = d.legacy("q1");
  const q2 = d.legacy("q2");
  await d.command({ type: "workspace.identity.link", workspaceId: p, identityId: P });
  await d.command({ type: "workspace.identity.link", workspaceId: q1, identityId: Q });
  await d.command({ type: "workspace.identity.link", workspaceId: q2, identityId: Q });
  d.changes.length = 0;
  expect(await d.command({ type: "workspace.identity.merge", from: Q, into: P })).toMatchObject({
    ok: true,
  });
  for (const id of [p, q1, q2]) expect(d.get(id).identity).toMatchObject({ id: P, aliases: [Q] });
  // Every registration whose reported identity changed is announced, P's own included.
  expect(new Set(d.changes.map((change) => change.workspaceId))).toEqual(new Set([p, q1, q2]));
});

test("a merge of a project into itself changes nothing", async () => {
  const d = await daemon();
  const p = d.legacy("p");
  await d.command({ type: "workspace.identity.link", workspaceId: p, identityId: P });
  d.changes.length = 0;
  expect(await d.command({ type: "workspace.identity.merge", from: P, into: P })).toMatchObject({
    ok: true,
  });
  expect(d.get(p).identity).toEqual({ id: P, aliases: [], source: "linked" });
  expect(d.changes).toEqual([]);
});

test("merges chain flat: R into Q, then Q into P, leaves P with both as aliases", async () => {
  const d = await daemon();
  const r = d.legacy("r");
  await d.command({ type: "workspace.identity.link", workspaceId: r, identityId: R });
  await d.command({ type: "workspace.identity.merge", from: R, into: Q });
  await d.command({ type: "workspace.identity.merge", from: Q, into: P });
  expect(d.get(r).identity?.id).toBe(P);
  expect(new Set(d.get(r).identity?.aliases)).toEqual(new Set([Q, R]));
  // Merging back the other way changes nothing: they are one project already.
  await d.command({ type: "workspace.identity.merge", from: P, into: Q });
  expect(d.get(r).identity?.id).toBe(P);
  expect(d.get(r).identity?.aliases).not.toContain(P);
});

test("a merge into a project merged here already lands in the one it went to", async () => {
  const d = await daemon();
  const r = d.legacy("r");
  await d.command({ type: "workspace.identity.link", workspaceId: r, identityId: R });
  await d.command({ type: "workspace.identity.merge", from: P, into: Q });
  await d.command({ type: "workspace.identity.merge", from: R, into: P });
  expect(d.get(r).identity).toMatchObject({ id: Q });
  expect(new Set(d.get(r).identity?.aliases)).toEqual(new Set([P, R]));
});

test("a registration reports only the 32 most recent aliases", async () => {
  const d = await daemon();
  const p = d.legacy("p");
  await d.command({ type: "workspace.identity.link", workspaceId: p, identityId: P });
  const merged = Array.from(
    { length: 40 },
    (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
  );
  for (const from of merged) await d.command({ type: "workspace.identity.merge", from, into: P });
  const aliases = d.get(p).identity?.aliases ?? [];
  expect(aliases).toHaveLength(32);
  expect(new Set(aliases)).toEqual(new Set(merged.slice(-32)));
});

test("unlinking splits off only that registration, into a fresh project, and keeps aliases", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  const b = d.legacy("b");
  await d.command({ type: "workspace.identity.link", workspaceId: a, identityId: P });
  await d.command({ type: "workspace.identity.link", workspaceId: b, identityId: P });
  await d.command({ type: "workspace.identity.merge", from: Q, into: P });
  const result = await d.command({ type: "workspace.identity.unlink", workspaceId: a });
  expect(result).toMatchObject({ ok: true });
  const fresh = d.get(a).identity;
  expect(fresh).toMatchObject({ source: "created", aliases: [] });
  expect(fresh?.id).not.toBe(P);
  expect(d.get(b).identity).toEqual({ id: P, aliases: [Q], source: "linked" });
});

test("identity commands are refused without the projects authority and change nothing", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  for (const payload of [
    { type: "workspace.identity.link", workspaceId: a, identityId: P },
    { type: "workspace.identity.unlink", workspaceId: a },
    { type: "workspace.identity.merge", from: Q, into: P },
  ] as const)
    expect(await d.command(payload, undefined, refused)).toMatchObject({ ok: false });
  expect(d.get(a).identity).toBeUndefined();
  expect(d.changes).toEqual([]);
});

test("an identity command repeated under its id is answered once, with the same result", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  const first = await d.command({ type: "workspace.identity.unlink", workspaceId: a }, "unlink-1");
  const again = await d.command({ type: "workspace.identity.unlink", workspaceId: a }, "unlink-1");
  expect(again).toEqual(first);
  expect(d.get(a).identity?.id).toBe(first.workspace?.identity?.id);
  // Durable: still the same answer after a restart.
  await d.restart();
  expect(
    await d.command({ type: "workspace.identity.unlink", workspaceId: a }, "unlink-1"),
  ).toEqual(first);
  expect(d.get(a).identity?.id).toBe(first.workspace?.identity?.id);
});

test("link, unlink and merge never change a thread's project, provider or session", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  d.thread("thread-a", a);
  const before = d.store.getThread("thread-a" as never);
  await d.command({ type: "workspace.identity.link", workspaceId: a, identityId: Q });
  await d.command({ type: "workspace.identity.merge", from: Q, into: P });
  await d.command({ type: "workspace.identity.unlink", workspaceId: a });
  const after = d.store.getThread("thread-a" as never);
  expect(after?.workspaceId).toBe(a);
  expect(after?.provider).toBe(before?.provider);
  expect(after?.continuation).toEqual(before?.continuation);
  expect(after?.backend).toEqual(before?.backend);
});

test("starting work in a project makes it the most recently used one there", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  expect(d.get(a).openedAt).toBeUndefined();
  d.thread("thread-a", a);
  const started = d.get(a).openedAt;
  expect(started).toBeGreaterThan(0);
  const b = d.legacy("b");
  d.thread("thread-b", b);
  expect(d.get(b).openedAt).toBeGreaterThan(started ?? Infinity);
});

test("merging an id that was merged here already keeps its whole group together", async () => {
  const d = await daemon();
  const p = d.legacy("p");
  const r = d.legacy("r");
  await d.command({ type: "workspace.identity.link", workspaceId: p, identityId: P });
  await d.command({ type: "workspace.identity.link", workspaceId: r, identityId: R });
  await d.command({ type: "workspace.identity.merge", from: Q, into: P });
  // Q went into P here; merging Q into R takes P (and so Q) along.
  await d.command({ type: "workspace.identity.merge", from: Q, into: R });
  expect(d.get(p).identity?.id).toBe(R);
  expect(new Set(d.get(r).identity?.aliases)).toEqual(new Set([P, Q]));
});

test("linking to an id merged here into another links to that other one", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  await d.command({ type: "workspace.identity.merge", from: Q, into: P });
  await d.command({ type: "workspace.identity.link", workspaceId: a, identityId: Q });
  expect(d.get(a).identity).toMatchObject({ id: P, aliases: [Q] });
});

test("without authority a link is refused the same for a project that exists and one that doesn't", async () => {
  const d = await daemon();
  const a = d.legacy("a");
  const missing = { type: "workspace.identity.unlink", workspaceId: "no-such-project" } as const;
  const present = { type: "workspace.identity.unlink", workspaceId: a } as const;
  const [one, two] = [
    await d.command(missing, undefined, refused),
    await d.command(present, undefined, refused),
  ];
  expect(one.error).toBe(two.error);
});

test("Spade's hidden project can't be linked or unlinked", async () => {
  const d = await daemon();
  const spade = d.spade("spade");
  for (const payload of [
    { type: "workspace.identity.link", workspaceId: spade, identityId: P },
    { type: "workspace.identity.unlink", workspaceId: spade },
  ] as const)
    expect(await d.command(payload)).toMatchObject({ ok: false });
});
