import { DeliveryEvent, Item, ServerMessage, Thread } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { createThreadView } from "./index.ts";
import { expandShortDeltas, shortDeltaJson } from "./short-deltas.ts";
import { wireTrims, WireTrimmer } from "./wire-trim.ts";

const frame = { type: "message_stop", data: { blob: "A".repeat(64) } };
const base = { agentId: "a", createdAt: 1 };
const items = {
  reply: Item.parse({
    ...base,
    id: "reply",
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    raw: [frame],
  }),
  shell: Item.parse({
    ...base,
    id: "shell",
    type: "tool_call",
    call: {
      id: "shell",
      agentId: "a",
      kind: "shell",
      title: "ls",
      status: "succeeded",
      detail: { kind: "shell", command: "ls" },
      startedAt: 1,
      raw: [frame],
    },
  }),
  ace: Item.parse({
    ...base,
    id: "ace",
    type: "tool_call",
    call: {
      id: "ace",
      agentId: "a",
      kind: "mcp",
      title: "thread_start",
      status: "succeeded",
      detail: { kind: "mcp", server: "ace", tool: "thread_start" },
      startedAt: 1,
      raw: [frame],
    },
  }),
  refusal: Item.parse({
    ...base,
    id: "refusal",
    type: "notice",
    level: "error",
    text: "refused",
    raw: [{ type: "ace.agent_control.failed", data: {} }],
  }),
};

function snapshot() {
  const view = createThreadView(
    Thread.parse({
      id: "t",
      workspaceId: "w",
      title: "t",
      provider: "claude",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    }),
    4,
  );
  view.items = structuredClone(items);
  view.itemOrder = Object.keys(items);
  view.itemSeqs = Object.fromEntries(Object.keys(items).map((id, index) => [id, index + 1]));
  return { type: "snapshot" as const, subscriptionId: "s", seq: 4, view };
}

const received = (trims: string[] | undefined) => {
  const [sent] = new WireTrimmer(trims).outgoing(snapshot());
  const parsed = ServerMessage.parse(JSON.parse(JSON.stringify(sent)));
  if (parsed.type !== "snapshot" || parsed.view.kind !== "thread") throw new Error("shape");
  return parsed.view.items;
};

describe("raw-on-demand", () => {
  it("a client that asks gets shown-only raw payloads left out and marked", () => {
    const got = received([wireTrims.rawOnDemand]);
    expect(got.reply).toMatchObject({ raw: [], rawOmitted: true });
    expect(got.shell).toMatchObject({ rawOmitted: true, call: { raw: [] } });
  });

  it("raw a client reads for what a step says stays: notices and ace's own calls", () => {
    const got = received([wireTrims.rawOnDemand]);
    expect(got.ace).toEqual(items.ace);
    expect(got.refusal).toEqual(items.refusal);
  });

  it("a client that doesn't ask gets every item exactly as stored", () => {
    const [sent] = new WireTrimmer(undefined).outgoing(snapshot());
    expect(JSON.stringify(sent)).toBe(JSON.stringify(snapshot()));
  });
});

describe("short deltas", () => {
  const delta = (seq: number, append: string, firstSeq?: number) =>
    DeliveryEvent.parse({
      id: `stored-${seq}`,
      seq,
      at: 1_731_600_000_000 + seq,
      threadId: "thread-1",
      ...(firstSeq === undefined ? {} : { firstSeq }),
      payload: { type: "item.delta", itemId: "reply", agentId: "a", field: "text", append },
    });

  it("a short-deltas client rebuilds the same deltas, text and order as a whole one", () => {
    const events = [delta(5, 'quote " and \n 😀'), delta(8, "tail", 6)];
    const json = `{"type":"events","subscriptionId":"s","afterSeq":4,"throughSeq":8,"threadId":"thread-1","events":[${events
      .map((event) => shortDeltaJson(event))
      .join(",")}]}`;
    const rebuilt = ServerMessage.parse(expandShortDeltas(JSON.parse(json)));
    if (rebuilt.type !== "events") throw new Error("shape");
    expect(rebuilt.events.map(({ id: _id, ...rest }) => rest)).toEqual(
      events.map(({ id: _id, ...rest }) => rest),
    );
    expect(rebuilt.events.map((event) => event.payload.type === "item.delta" && event.payload.append).join("")).toBe(
      'quote " and \n 😀tail',
    );
  });

  it("a short delta is far smaller than the whole event", () => {
    const event = delta(5, "x".repeat(150));
    const short = shortDeltaJson(event) ?? "";
    expect(short.length).toBeLessThan(JSON.stringify(event).length - 40);
  });
});
