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

test("a refused answer is shown once and never kept", async () => {
  const { client, daemon } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready", "connected");
  daemon.refuseRequests("unavailable", "usage.limits");
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
  services.handle({ type: "service", id: "limits", request: { type: "usage.limits" }, cache: "l" });
  await until(() => sink.read("service:limits") !== undefined, "answered");
  expect(sink.read("service:limits")).not.toHaveProperty("cache");
  expect(reads.fresh({ key: "l", family: "usage" })).toBeUndefined();
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
