import { expect, it } from "vitest";
import type { ServerMessage } from "@ace/protocol";
import { filterProductionFileTap } from "./production-runtime.ts";

function fileChanged(): ServerMessage {
  return {
    type: "files.changed",
    change: { id: "c1", op: "save", path: "note.md", version: null },
  } as unknown as ServerMessage;
}

function fileEvent(seq: number): Record<string, unknown> {
  return {
    seq,
    id: `e${seq}`,
    at: 1_700_000_000_000 + seq,
    threadId: "thread-1",
    payload: { type: "workspace.files_changed", workspaceId: "ace", change: { id: `c${seq}` } },
  };
}

function unrelatedEvent(seq: number, marker: string): Record<string, unknown> {
  return {
    seq,
    id: `e${seq}`,
    at: 1_700_000_000_000 + seq,
    threadId: "thread-9",
    payload: { type: "thread.updated", title: marker },
  };
}

function batch(events: Record<string, unknown>[]): ServerMessage {
  return {
    type: "events",
    subscriptionId: "sub-1",
    afterSeq: 0,
    throughSeq: events.length,
    events,
  } as unknown as ServerMessage;
}

it("passes files.changed through untouched", () => {
  const message = fileChanged();
  expect(filterProductionFileTap(message)).toBe(message);
});

it("drops event batches with no file-change entry", () => {
  expect(filterProductionFileTap(batch([unrelatedEvent(1, "nope")]))).toBeUndefined();
  expect(filterProductionFileTap(batch([]))).toBeUndefined();
});

it("narrows mixed batches to file-change entries only", () => {
  const marker = `secret-title-${Date.now()}`;
  const message = batch([unrelatedEvent(1, marker), fileEvent(2), unrelatedEvent(3, marker)]);
  const tap = filterProductionFileTap(message);
  expect(tap).toBeDefined();
  expect(tap?.type).toBe("events");
  const events = (tap as unknown as { events: { payload?: { type?: unknown } }[] }).events;
  expect(events).toHaveLength(1);
  expect(events[0]?.payload?.type).toBe("workspace.files_changed");
  expect(JSON.stringify(tap)).not.toContain(marker);
  expect((tap as unknown as { subscriptionId?: unknown }).subscriptionId).toBe("sub-1");
});

it("passes batches with only file-change entries through untouched", () => {
  const message = batch([fileEvent(1), fileEvent(2)]);
  expect(filterProductionFileTap(message)).toBe(message);
});

it("drops non-file server messages", () => {
  expect(
    filterProductionFileTap({
      type: "progress",
      subscriptionId: "s",
      afterSeq: 0,
      throughSeq: 0,
    } as unknown as ServerMessage),
  ).toBeUndefined();
  expect(
    filterProductionFileTap({
      type: "error",
      code: "boom",
      message: "boom",
    } as unknown as ServerMessage),
  ).toBeUndefined();
});
