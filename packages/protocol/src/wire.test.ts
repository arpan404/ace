import { describe, expect, it } from "vitest";
import { DeliveryEvent, ServerMessage } from "./wire.ts";

describe("wire schemas", () => {
  it("validates coalesced sequence ranges", () => {
    const event = {
      seq: 5,
      firstSeq: 2,
      id: "e",
      threadId: "t",
      at: 1,
      payload: { type: "item.delta", itemId: "i", agentId: "a", field: "text", append: "abcd" },
    };
    expect(DeliveryEvent.safeParse(event).success).toBe(true);
    expect(DeliveryEvent.safeParse({ ...event, firstSeq: 6 }).success).toBe(false);
    expect(
      DeliveryEvent.safeParse({ ...event, payload: { type: "thread.updated", title: "title" } })
        .success,
    ).toBe(false);
  });
  it("rejects a snapshot whose envelope disagrees with its continuation cursor", () => {
    const result = ServerMessage.safeParse({
      type: "snapshot",
      subscriptionId: "s",
      seq: 3,
      view: { kind: "threads", seq: 2, threads: {} },
    });
    expect(result.success).toBe(false);
    expect(
      ServerMessage.safeParse({
        type: "snapshot",
        subscriptionId: "s",
        seq: 3,
        view: { kind: "threads", seq: 3, threads: {} },
      }).success,
    ).toBe(true);
  });
  it("allows scoped holes but rejects event ranges outside the delivery watermark", () => {
    const event = {
      seq: 5,
      id: "e",
      at: 5,
      threadId: "t",
      payload: { type: "thread.updated", title: "Changed" },
    };
    const batch = {
      type: "events",
      subscriptionId: "s",
      afterSeq: 2,
      throughSeq: 8,
      events: [event],
    };
    expect(ServerMessage.safeParse(batch).success).toBe(true);
    expect(ServerMessage.safeParse({ ...batch, throughSeq: 4 }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...batch, events: [event, event] }).success).toBe(false);
    expect(
      ServerMessage.safeParse({ type: "progress", subscriptionId: "s", afterSeq: 2, throughSeq: 8 })
        .success,
    ).toBe(true);
    expect(
      ServerMessage.safeParse({ type: "progress", subscriptionId: "s", afterSeq: 8, throughSeq: 2 })
        .success,
    ).toBe(false);
  });
});

it("decodes every own snapshot entity key without losing prototype-like identifiers", () => {
  const thread = {
    id: "__proto__",
    workspaceId: "w",
    title: "Title",
    provider: "codex",
    status: { state: "working", agents: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
  const agent = {
    id: "__proto__",
    threadId: "__proto__",
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "working", activity: "starting_turn" },
    background: false,
    createdAt: 1,
  };
  const rows = {
    agents: agent,
    agentChildren: ["child"],
    runs: {
      id: "__proto__",
      threadId: "__proto__",
      agentId: "__proto__",
      trigger: "user",
      state: "active",
      startedAt: 1,
    },
    items: {
      id: "__proto__",
      agentId: "__proto__",
      type: "notice",
      level: "info",
      text: "Preserve me",
      complete: true,
      raw: [],
      createdAt: 1,
    },
    interactions: {
      id: "__proto__",
      threadId: "__proto__",
      agentId: "__proto__",
      blocking: true,
      request: { kind: "approval", title: "Allow?", options: [] },
      state: "pending",
      raw: [],
      createdAt: 1,
    },
    backgroundTasks: {
      id: "__proto__",
      agentId: "__proto__",
      kind: "shell",
      title: "Build",
      status: "running",
      stoppable: true,
      ambient: false,
      raw: [],
      startedAt: 1,
    },
    usage: { type: "usage.updated", agentId: "__proto__", inputTokens: 1, outputTokens: 2 },
  };
  const view = {
    kind: "thread",
    seq: 3,
    thread,
    ...Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, { ["__proto__"]: row }])),
    itemOrder: ["__proto__"],
    itemsBefore: null,
    usageSnapshots: {},
  };
  const snapshot = { type: "snapshot", subscriptionId: "s", seq: 3, view };
  expect(ServerMessage.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  const sidebar = {
    type: "snapshot",
    subscriptionId: "s",
    seq: 3,
    view: { kind: "threads", seq: 3, threads: { ["__proto__"]: thread } },
  };
  expect(ServerMessage.parse(JSON.parse(JSON.stringify(sidebar)))).toEqual(sidebar);
  const invalid = {
    ...snapshot,
    view: { ...view, items: { ["__proto__"]: { ...rows.items, text: 123 } } },
  };
  expect(ServerMessage.safeParse(invalid).success).toBe(false);
});
