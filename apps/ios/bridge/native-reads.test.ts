import "./test-host.ts";
import type { ConnectionState } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { NativeReads, type ReadsOwner } from "./native-reads.ts";
import { NativeServices } from "./native-services.ts";
import { keptRecord, parseKeptRecord } from "./read-cache.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A daemon connection whose broadcasts and state the test drives. */
function fakeOwner() {
  const listeners = new Set<(message: ServerMessage) => void>();
  const watchers = new Set<() => void>();
  let state: ConnectionState = "ready";
  const owner: ReadsOwner = {
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connectionState: () => ({
      getSnapshot: () => state,
      subscribe(listener) {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    }),
  };
  return {
    owner,
    broadcast(message: unknown) {
      // Only the type matters to the cache; the rest of a broadcast is the daemon's.
      for (const listener of listeners) listener(message as ServerMessage);
    },
    connect(next: ConnectionState) {
      state = next;
      for (const watcher of watchers) watcher();
    },
  };
}
const noSchedule = () => () => {};
const projectsRead = { type: "projects.request", operation: { op: "workspace.list", limit: 100 } };

test("a revisit inside the stale time is answered from the kept read, and Swift is told its name", async () => {
  const { client, daemon } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready", "connected");
  const sink = new RecordingSink();
  const reads = new NativeReads(client, sink, { now: () => 0, schedule: noSchedule });
  const services = new NativeServices(
    client,
    sink,
    undefined,
    undefined,
    undefined,
    undefined,
    reads,
  );
  const read = { type: "settings.get", key: "threads.followUpBehavior", scope: {} };
  services.handle({ type: "service", id: "first", request: read, cache: "follow-up" });
  await until(() => sink.read("service:first") !== undefined, "first read");
  expect(sink.read("service:first")).toMatchObject({
    ok: true,
    cache: { key: "follow-up", family: "settings" },
  });
  // The daemon now fails this read: an answer can only come from what was kept.
  daemon.failRequests("settings.get");
  services.handle({ type: "service", id: "again", request: read, cache: "follow-up" });
  expect(sink.read("service:again")).toMatchObject({
    ok: true,
    value: sink.read("service:first")?.value,
    cache: { key: "follow-up" },
  });
});

test("saving a setting puts the kept settings out of date, so the next read shows the new value", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready", "connected");
  const sink = new RecordingSink();
  const reads = new NativeReads(client, sink, { now: () => 0, schedule: noSchedule });
  const services = new NativeServices(
    client,
    sink,
    undefined,
    undefined,
    undefined,
    undefined,
    reads,
  );
  const read = { type: "settings.get", key: "threads.followUpBehavior", scope: {} };
  services.handle({ type: "service", id: "before", request: read, cache: "follow-up" });
  await until(() => sink.read("service:before") !== undefined, "first read");
  services.handle({
    type: "service",
    id: "save",
    request: {
      type: "settings.set",
      key: "threads.followUpBehavior",
      value: "queue",
      layer: { kind: "global" },
    },
  });
  await until(() => sink.read("service:save") !== undefined, "saved");
  expect(sink.read("service:generations")).toMatchObject({ generations: { settings: 1 } });
  services.handle({ type: "service", id: "after", request: read, cache: "follow-up" });
  await until(() => sink.read("service:after") !== undefined, "read again");
  expect(sink.read("service:after")).toMatchObject({
    ok: true,
    value: { entries: [{ value: "queue" }] },
  });
});

test("a refused answer is shown once and never kept", () => {
  const reads = new NativeReads(fakeOwner().owner, new RecordingSink(), {
    now: () => 0,
    schedule: noSchedule,
  });
  const read = reads.key(projectsRead, "projects");
  if (!read) throw new Error("expected a kept read");
  expect(reads.answered(read, { result: { kind: "error", code: "forbidden" } })).toBe(false);
  expect(reads.answered(read, { ok: false, error: "automation_unavailable" })).toBe(false);
  expect(reads.fresh(read)).toBeUndefined();
});

test("a daemon change event moves only its families' generations and puts their reads out of date", () => {
  const { owner, broadcast } = fakeOwner();
  const sink = new RecordingSink();
  const reads = new NativeReads(owner, sink, { now: () => 0, schedule: noSchedule });
  const projects = reads.key(projectsRead, "projects");
  const usage = reads.key({ type: "usage.limits" }, "limits");
  if (!projects || !usage) throw new Error("expected kept reads");
  reads.answered(projects, { result: { kind: "workspaces", workspaces: [] } });
  reads.answered(usage, { providers: [] });
  broadcast({ type: "workspace.changed", workspaceId: "w", change: "added" });
  expect(sink.read("service:generations")).toEqual({
    type: "service.generations",
    generations: { projects: 1, "source-control": 1 },
  });
  expect(reads.fresh(projects)).toBeUndefined();
  expect(reads.fresh(usage)).toEqual({ providers: [] });
});

test("coming back online puts every kept read out of date, as the web refetches on reconnect", () => {
  const { owner, connect } = fakeOwner();
  const sink = new RecordingSink();
  const reads = new NativeReads(owner, sink, { now: () => 0, schedule: noSchedule });
  const usage = reads.key({ type: "usage.limits" }, "limits");
  if (!usage) throw new Error("expected a kept read");
  reads.answered(usage, { providers: [] });
  connect("reconnecting");
  expect(reads.fresh(usage)).toEqual({ providers: [] });
  connect("ready");
  expect(reads.fresh(usage)).toBeUndefined();
  expect(sink.read("service:generations")).toMatchObject({ generations: { usage: 1 } });
});

test("kept reads outlive the app: restored out of date and handed to Swift before any screen asks", async () => {
  let saved = "";
  const runs: (() => void)[] = [];
  const storage = {
    load: async () => saved,
    save: async (text: string) => {
      saved = text;
    },
  };
  const first = new NativeReads(fakeOwner().owner, new RecordingSink(), {
    now: () => 10,
    schedule: (_delay, run) => {
      runs.push(run);
      return () => {};
    },
    storage,
  });
  const read = first.key(projectsRead, "projects");
  if (!read) throw new Error("expected a kept read");
  first.answered(read, { result: { kind: "workspaces", workspaces: [{ id: "w" }] } });
  first.answered(read, { result: { kind: "workspaces", workspaces: [{ id: "w2" }] } });
  expect(runs).toHaveLength(1);
  runs[0]?.();
  await until(() => saved !== "", "written");

  const sink = new RecordingSink();
  const second = new NativeReads(fakeOwner().owner, sink, {
    now: () => 20,
    schedule: noSchedule,
    storage,
  });
  await second.restore();
  expect(sink.read("service:cache:projects")).toEqual({
    type: "service.cache",
    key: "projects",
    family: "projects",
    value: { result: { kind: "workspaces", workspaces: [{ id: "w2" }] } },
  });
  expect(second.fresh(read)).toBeUndefined();
});

test("the kept record holds the newest answers that fit, and another version reads as empty", () => {
  const reads = [
    { key: "old", family: "usage" as const, value: "x".repeat(60), at: 1 },
    { key: "new", family: "usage" as const, value: "y".repeat(60), at: 2 },
  ];
  expect(parseKeptRecord(keptRecord(reads, 120)).map((read) => read.key)).toEqual(["new"]);
  expect(parseKeptRecord('{"version":0,"reads":[]}')).toEqual([]);
  expect(parseKeptRecord("not json")).toEqual([]);
});

test("a kept read the screen stopped waiting for still finishes and is kept for the next visit", async () => {
  const { client, daemon } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready", "connected");
  daemon.holdRequests("settings.get");
  const sink = new RecordingSink();
  const reads = new NativeReads(client, sink, { now: () => 0, schedule: noSchedule });
  const services = new NativeServices(
    client,
    sink,
    undefined,
    undefined,
    undefined,
    undefined,
    reads,
  );
  const read = { type: "settings.get", key: "threads.followUpBehavior", scope: {} };
  services.handle({ type: "service", id: "left", request: read, cache: "follow-up" });
  services.handle({ type: "service.cancel", id: "left" });
  daemon.restoreRequests();
  await until(() => sink.read("service:left") !== undefined, "finished");
  expect(sink.read("service:left")).toMatchObject({ ok: true, cache: { key: "follow-up" } });
  expect(reads.fresh({ key: "follow-up", family: "settings" })).toBeDefined();
});

test("each return of the connection is counted for screens whose reads aren't kept", () => {
  const { owner, connect } = fakeOwner();
  const sink = new RecordingSink();
  // oxlint-disable-next-line no-new -- It watches the connection as it is built; the sink shows what it read.
  new NativeReads(owner, sink, { now: () => 0, schedule: noSchedule });
  connect("reconnecting");
  connect("ready");
  expect(sink.read("service:generations")).toMatchObject({ generations: { reconnects: 1 } });
  connect("ready");
  connect("offline");
  // Going away reads nothing; only coming back counts.
  expect(sink.read("service:generations")).toMatchObject({ generations: { reconnects: 1 } });
  connect("ready");
  expect(sink.read("service:generations")).toMatchObject({ generations: { reconnects: 2 } });
});

test("an answer asked before its family went out of date is shown but never kept as fresh", () => {
  const { owner, broadcast } = fakeOwner();
  const reads = new NativeReads(owner, new RecordingSink(), { now: () => 0, schedule: noSchedule });
  const asked = reads.key(projectsRead, "projects");
  if (!asked) throw new Error("expected a kept read");
  broadcast({ type: "workspace.changed", workspaceId: "w", change: "removed" });
  expect(reads.answered(asked, { result: { kind: "workspaces", workspaces: ["old"] } })).toBe(
    false,
  );
  expect(reads.fresh(asked)).toBeUndefined();
});

test("an answer asked before the connection came back is never kept as fresh", () => {
  const { owner, connect } = fakeOwner();
  const reads = new NativeReads(owner, new RecordingSink(), { now: () => 0, schedule: noSchedule });
  const asked = reads.key({ type: "usage.limits" }, "limits");
  if (!asked) throw new Error("expected a kept read");
  connect("reconnecting");
  connect("ready");
  expect(reads.answered(asked, { providers: ["old"] })).toBe(false);
  expect(reads.fresh(asked)).toBeUndefined();
});

test("an older answer landing after a newer one never replaces it", () => {
  const reads = new NativeReads(fakeOwner().owner, new RecordingSink(), {
    now: () => 0,
    schedule: noSchedule,
  });
  const older = reads.key({ type: "usage.limits" }, "limits");
  const newer = reads.key({ type: "usage.limits" }, "limits");
  if (!older || !newer) throw new Error("expected kept reads");
  expect(reads.answered(newer, { providers: ["new"] })).toBe(true);
  expect(reads.answered(older, { providers: ["old"] })).toBe(false);
  expect(reads.fresh(newer)).toEqual({ providers: ["new"] });
});

test("a family's stamp moves with its events and with the connection coming back, not with others", () => {
  const { owner, broadcast, connect } = fakeOwner();
  const reads = new NativeReads(owner, new RecordingSink(), { now: () => 0, schedule: noSchedule });
  const start = reads.stamp("forge");
  broadcast({ type: "usage.updated" });
  expect(reads.stamp("forge")).toBe(start);
  broadcast({ type: "forge.pr.updated" });
  const updated = reads.stamp("forge");
  expect(updated).not.toBe(start);
  connect("reconnecting");
  connect("ready");
  expect(reads.stamp("forge")).not.toBe(updated);
});

test("an answer the bridge stops keeping leaves Swift's copy too, even one still waiting to be sent", () => {
  const sink = new RecordingSink();
  const reads = new NativeReads(fakeOwner().owner, sink, {
    now: () => 0,
    schedule: noSchedule,
    limit: 2,
  });
  for (const name of ["first", "second", "third"]) {
    const read = reads.key({ type: "usage.limits" }, name);
    if (!read) throw new Error("expected a kept read");
    reads.answered(read, { providers: [name] });
  }
  expect(sink.read("service:cache:first")).toEqual({ type: "service.evict", key: "first" });
  expect(sink.read("service:cache:second")).toBeUndefined();
});
