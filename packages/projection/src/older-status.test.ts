import {
  HostId,
  KnownThreadStatus,
  ServerMessage,
  Thread,
  ThreadId,
  type ThreadStatus,
} from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { supportedWireTrims, WireTrimmer } from "./wire-trim.ts";

/** The thread status a client built before ADR 0191 decodes: no `moved`, nothing lenient. */
const preMoveStatus = z.discriminatedUnion(
  "state",
  KnownThreadStatus.options.filter(
    (option) => option.shape.state.value !== "moved" && option.shape.state.value !== "unknown",
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
);
const preMoveSearchState = z.enum([
  "new",
  "working",
  "waiting",
  "needs_you",
  "limited",
  "done",
  "failed",
  "unresponsive",
]);

const to = { hostId: HostId.parse("studio"), name: "Studio", threadId: ThreadId.parse("there") };
const moved: ThreadStatus = { state: "moved", to };
const continuedOn = { ...to, at: 5 };
const movedThread = Thread.parse({
  id: "t",
  workspaceId: "w",
  title: "Login bug",
  provider: "claude",
  status: moved,
  details: { continuedOn },
  createdAt: 1,
  updatedAt: 5,
});

/** Every place a thread status rides to a client, each carrying a moved one. */
const messages: ServerMessage[] = [
  ServerMessage.parse({
    type: "threads.patch",
    subscriptionId: "list",
    seq: 9,
    threads: { t: movedThread },
    removed: [],
    window: { before: null, total: 1, counts: [] },
  }),
  ServerMessage.parse({
    type: "events",
    subscriptionId: "thread",
    afterSeq: 8,
    throughSeq: 9,
    events: [
      {
        id: "e9",
        seq: 9,
        threadId: "t",
        at: 5,
        payload: { type: "thread.updated", status: moved },
      },
    ],
  }),
  ServerMessage.parse({
    type: "search.results",
    requestId: "q",
    hits: [
      {
        threadId: "t",
        threadTitle: "Login bug",
        workspaceId: "w",
        provider: "claude",
        status: "moved",
        statusSeq: 9,
        kind: "message",
        createdAt: 1,
        title: { text: "Login bug", highlights: [] },
        snippet: { text: "login", highlights: [] },
        score: 1,
      },
    ],
    cursor: null,
    generation: 1,
  }),
];

const statusesIn = (message: ServerMessage): unknown[] => {
  switch (message.type) {
    case "threads.patch":
      return Object.values(message.threads).map((thread) => thread.status);
    case "events":
      return message.events.map((event) =>
        event.payload.type === "thread.updated" ? event.payload.status : undefined,
      );
    default:
      return [];
  }
};
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("moved thread status on the wire", () => {
  it("reaches a client that predates it as waiting on upstream, which that client decodes", () => {
    const older = new WireTrimmer(supportedWireTrims.filter((trim) => trim !== "moved-status"));
    for (const message of messages) {
      const [frame, ...rest] = older.outgoing(message);
      expect(rest).toEqual([]);
      const sent = wire(frame) as ServerMessage;
      expect(JSON.stringify(sent)).not.toContain('"moved"');
      for (const status of statusesIn(sent)) {
        expect(preMoveStatus.parse(status)).toEqual({ state: "waiting", on: "upstream" });
      }
      if (sent.type === "search.results")
        expect(preMoveSearchState.parse(sent.hits[0]?.status)).toBe("waiting");
    }
    // The thread still says where its work went.
    const [patch] = older.outgoing(messages[0] as ServerMessage);
    expect(patch?.type === "threads.patch" && patch.threads.t?.details?.continuedOn).toEqual(
      continuedOn,
    );
  });

  it("reaches a client that asked for it unchanged", () => {
    const current = new WireTrimmer(supportedWireTrims);
    for (const message of messages) {
      const [frame] = current.outgoing(message);
      expect(ServerMessage.parse(wire(frame))).toEqual(ServerMessage.parse(wire(message)));
    }
    const [patch] = current.outgoing(messages[0] as ServerMessage);
    expect(patch?.type === "threads.patch" && patch.threads.t?.status).toEqual(moved);
  });

  it("leaves a message without a moved status as it was, for any client", () => {
    const working = ServerMessage.parse({
      type: "threads.patch",
      subscriptionId: "list",
      seq: 3,
      threads: { t: { ...movedThread, status: { state: "working", agents: 1 } } },
      removed: [],
      window: { before: null, total: 1, counts: [] },
    });
    expect(new WireTrimmer(undefined).outgoing(working)[0]).toBe(working);
  });
});
