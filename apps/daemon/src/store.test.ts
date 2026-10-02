import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Command, Thread, WorkspaceId, type Event } from "@ace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup(onError: (error: unknown) => void = console.error) {
  const home = mkdtempSync(join(tmpdir(), "ace-store-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  let store = new Store(join(home, "events.sqlite"), onError);
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace);
  return {
    get store() {
      return store;
    },
    thread,
    dbPath: join(home, "events.sqlite"),
    reopen() {
      store.close();
      store = new Store(join(home, "events.sqlite"), onError);
    },
  };
}
describe("store", () => {
  it("appends, reads, projects and maintains gap-free sequences across many appends", () => {
    const { store, thread } = setup();
    for (let i = 0; i < 100; i++)
      store.appendEvents(
        thread.id,
        [
          { type: "thread.updated", title: `Title ${i}` },
          { type: "thread.updated", status: { state: "done" } },
        ],
        i + 10,
      );
    const events = store.readEvents({ afterSeq: 0, limit: 1000 });
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 201 }, (_, i) => i + 1));
    expect(new Set(events.map((e) => e.id)).size).toBe(201);
    expect(store.headSeq()).toBe(201);
    expect(store.listThreads()[0]).toMatchObject({
      title: "Title 99",
      updatedAt: 109,
      status: { state: "done" },
    });
    expect(store.readEvents({ afterSeq: 199, threadId: thread.id, limit: 1 })[0]?.seq).toBe(200);
  });
  it("rolls back projection and log together and only publishes after commit", () => {
    const { store, thread, dbPath } = setup();
    const observer = new Store(dbPath);
    cleanup.push(() => observer.close());
    const seen: Event[] = [];
    const committed: { seq: number; title: string | undefined }[] = [];
    store.subscribe((events) => {
      committed.push({ seq: observer.headSeq(), title: observer.getThread(thread.id)?.title });
      seen.push(...events);
    });
    expect(() =>
      store.appendEvents(thread.id, [
        { type: "thread.updated", title: "Rolled back" },
        { type: "thread.created", thread },
      ]),
    ).toThrow();
    expect(store.headSeq()).toBe(1);
    expect(store.getThread(thread.id)?.title).toBe(thread.title);
    expect(seen).toEqual([]);
    store.appendEvents(thread.id, [{ type: "thread.updated", title: "Committed" }]);
    expect(seen[0]?.seq).toBe(2);
    expect(committed).toEqual([{ seq: 2, title: "Committed" }]);
  });
  it("atomically records receipts with their events, repeats results and survives reopen", () => {
    const state = setup();
    const command = Command.parse({
      id: "command",
      deviceId: "device",
      payload: { type: "thread.archive", threadId: state.thread.id },
    });
    const run = () => {
      state.store.appendEvents(state.thread.id, [{ type: "thread.updated", archivedAt: 10 }]);
      return { commandId: command.id, ok: true };
    };
    const first = state.store.recordCommand(command.id, command.deviceId, run);
    expect(state.store.recordCommand(command.id, command.deviceId, run)).toEqual(first);
    expect(state.store.headSeq()).toBe(2);
    state.reopen();
    expect(state.store.recordCommand(command.id, command.deviceId, run)).toEqual(first);
    expect(state.store.listThreads()[0]?.archivedAt).toBe(10);
    expect(state.store.acquireThread(state.thread.id).thread.archivedAt).toBe(10);
  });
  it("rolls back failed handlers so retries can execute", () => {
    const { store, thread } = setup();
    const c = Command.parse({
      id: "fail",
      deviceId: "d",
      payload: { type: "thread.archive", threadId: thread.id },
    });
    expect(() =>
      store.recordCommand(c.id, c.deviceId, () => {
        store.appendEvents(thread.id, [{ type: "thread.updated", archivedAt: 2 }]);
        throw new Error("failure");
      }),
    ).toThrow("failure");
    expect(store.headSeq()).toBe(1);
    expect(store.getThread(thread.id)?.archivedAt).toBeUndefined();
    const result = store.recordCommand(c.id, c.deviceId, () => ({
      commandId: c.id,
      ok: false,
      error: "not_implemented",
    }));
    expect(store.recordCommand(c.id, c.deviceId, () => ({ commandId: c.id, ok: true }))).toEqual(
      result,
    );
  });
  it("subscribed views stay current across other threads and rebuild after restart", () => {
    const state = setup();
    const view = state.store.acquireThread(state.thread.id);
    const workspace = state.store.createWorkspace("/other", "Other");
    createDevThread(state.store, workspace);
    state.store.appendEvents(state.thread.id, [{ type: "thread.updated", title: "Live" }]);
    expect(view.seq).toBe(3);
    expect(view.thread.title).toBe("Live");
    state.store.releaseThread(state.thread.id);
    expect(state.store.acquireThread(state.thread.id)).toEqual(view);
    state.reopen();
    expect(state.store.acquireThread(state.thread.id)).toEqual(view);
  });
  it("keeps bus order when listeners append reentrantly", () => {
    const { store, thread } = setup();
    const observed: number[] = [];
    const stop = store.subscribe((events) => {
      if (events[0]?.seq === 2)
        store.appendEvents(thread.id, [{ type: "thread.updated", title: "Nested" }]);
    });
    store.subscribe((events) => observed.push(...events.map((e) => e.seq)));
    store.appendEvents(thread.id, [{ type: "thread.updated", title: "Outer" }]);
    expect(observed).toEqual([2, 3]);
    stop();
  });
  it("rejects orphan threads without adding events or sidebar entries", () => {
    const { store, thread } = setup();
    const orphan = Thread.parse({
      ...thread,
      id: "orphan",
      workspaceId: WorkspaceId.parse("missing"),
    });
    expect(() =>
      store.appendEvents(orphan.id, [{ type: "thread.created", thread: orphan }]),
    ).toThrow();
    expect(store.headSeq()).toBe(1);
    expect(store.listThreads().map((t) => t.id)).toEqual([thread.id]);
  });
  it("cannot leak a partially rejected batch when the handler catches its error", () => {
    const { store, thread } = setup();
    const c = Command.parse({
      id: "caught",
      deviceId: "d",
      payload: { type: "thread.archive", threadId: thread.id },
    });
    const seen: Event[] = [];
    store.subscribe((events) => seen.push(...events));
    const result = store.recordCommand(c.id, c.deviceId, () => {
      try {
        store.appendEvents(thread.id, [
          { type: "thread.updated", title: "Partial" },
          { type: "thread.created", thread },
        ]);
      } catch {
        return { commandId: c.id, ok: false, error: "rejected" };
      }
      throw new Error("Expected invalid creation to fail");
    });
    expect(result).toMatchObject({ ok: false, error: "rejected" });
    expect(store.headSeq()).toBe(1);
    expect(store.getThread(thread.id)?.title).toBe(thread.title);
    expect(seen).toEqual([]);
    store.appendEvents(thread.id, [{ type: "thread.updated", title: "Next" }]);
    expect(seen.map((e) => e.seq)).toEqual([2]);
  });
  it("keeps publishing committed events to healthy subscribers after another subscriber throws", () => {
    const { store, thread } = setup(() => {
      throw new Error("Reporter failed too");
    });
    const delivered: Event[] = [];
    store.subscribe(() => {
      throw new Error("Subscriber failed");
    });
    store.subscribe((events) => delivered.push(...events));
    const events = store.appendEvents(thread.id, [
      { type: "thread.updated", title: "Committed despite observer" },
    ]);
    expect(delivered).toEqual(events);
    expect(store.readEvents({ afterSeq: 1, limit: 10 })).toEqual(events);
    expect(store.getThread(thread.id)?.title).toBe("Committed despite observer");
  });
  it("keeps a view live until the final owner releases it, then rebuilds a fresh view", () => {
    const { store, thread } = setup();
    const view = store.acquireThread(thread.id);
    store.acquireThread(thread.id);
    store.releaseThread(thread.id);
    store.appendEvents(thread.id, [{ type: "thread.updated", title: "Still owned" }]);
    expect(view.thread.title).toBe("Still owned");
    store.releaseThread(thread.id);
    store.appendEvents(thread.id, [{ type: "thread.updated", title: "After release" }]);
    expect(view.thread.title).toBe("Still owned");
    const fresh = store.acquireThread(thread.id);
    expect(fresh.thread.title).toBe("After release");
    expect(fresh.seq).toBe(3);
    store.releaseThread(thread.id);
  });
  it("persists the root agent identity from its creation event across reopen", () => {
    const state = setup();
    const root = Agent.parse({
      id: "root",
      threadId: state.thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: "/repo",
      status: { state: "starting" },
      createdAt: 1,
    });
    state.store.appendEvents(state.thread.id, [{ type: "agent.created", agent: root }]);
    expect(state.store.getThread(state.thread.id)?.rootAgentId).toBe(root.id);
    state.reopen();
    expect(state.store.getThread(state.thread.id)?.rootAgentId).toBe(root.id);
    expect(state.store.acquireThread(state.thread.id).thread.rootAgentId).toBe(root.id);
  });
});
