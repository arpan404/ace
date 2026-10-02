import { expect, it } from "vitest";
import { harness } from "./replay.ts";

function setup() {
  const h = harness();
  let seq = 0;
  const event = (type: string, properties: unknown) =>
    h.feed({
      seq: seq++,
      t: seq,
      dir: "recv",
      channel: "sse",
      data: { payload: { type, properties } },
    });
  const lifecycle = (type: string) =>
    h.feed({ seq: seq++, t: seq, dir: "note", channel: "lifecycle", data: { type } });
  event("session.created", { info: { id: "native_root", directory: "/work" } });
  event("message.updated", { sessionID: "native_root", info: { id: "user", role: "user" } });
  event("session.status", { sessionID: "native_root", status: { type: "busy" } });
  return { ...h, event, lifecycle };
}

it.each(["tool", "text", "reasoning"])(
  "retains unknown envelope fields around a recognized %s part",
  (type) => {
    const h = setup();
    h.event("message.part.updated", {
      unknownFuture: "FUTURE_SIBLING_17",
      part: {
        id: "part",
        sessionID: "native_root",
        type,
        text: "text",
        tool: "bash",
        state: { status: "running", input: { command: "offline" } },
      },
    });
    expect(JSON.stringify(Object.values(h.view.items))).toContain("FUTURE_SIBLING_17");
  },
);

it("keeps a disconnected approval unresponsive through heartbeats and restores only after resync", () => {
  const h = setup();
  h.event("permission.asked", { id: "permission", sessionID: "native_root", permission: "bash" });
  expect(h.view.thread.status.state).toBe("needs_you");
  h.lifecycle("disconnected");
  expect(Object.values(h.view.interactions)[0]?.state).toBe("expired");
  expect(h.view.thread.status.state).toBe("unresponsive");
  h.event("server.heartbeat", {});
  h.event("session.status", { sessionID: "native_root", status: { type: "busy" } });
  expect(h.view.thread.status.state).toBe("unresponsive");
  h.lifecycle("resynced");
  expect(h.view.thread.status.state).toBe("working");
  h.event("session.status", { sessionID: "native_root", status: { type: "idle" } });
  expect(h.view.thread.status.state).toBe("done");
});

it("idling one child evicts only its completed reasoning and keeps another child's live delta route", () => {
  const h = setup();
  for (const id of ["first", "second"]) {
    h.event("session.created", { info: { id, parentID: "native_root" } });
    h.event("message.part.updated", {
      part: { id: `thought_${id}`, sessionID: id, type: "reasoning", text: "a" },
    });
  }
  h.event("session.status", { sessionID: "first", status: { type: "idle" } });
  for (let i = 0; i < 300; i++)
    h.event("message.part.updated", {
      part: {
        id: `complete_${i}`,
        sessionID: "first",
        type: "text",
        text: "done",
        time: { end: 1 },
      },
    });
  h.event("message.part.delta", {
    sessionID: "second",
    partID: "thought_second",
    field: "text",
    delta: "b",
  });
  h.event("message.part.delta", {
    sessionID: "first",
    partID: "thought_first",
    field: "text",
    delta: "discarded",
  });
  const reasoning = Object.values(h.view.items).filter((item) => item.type === "reasoning");
  expect(reasoning.map((item) => item.text)).toEqual(["a", "ab"]);
});

it("keeps children discovered during recovery unresponsive until the whole stream is restored", () => {
  const h = setup();
  h.lifecycle("disconnected");
  h.event("session.created", { info: { id: "late_child", parentID: "native_root" } });
  h.event("message.updated", { sessionID: "late_child", info: { id: "child_user", role: "user" } });
  h.event("session.status", { sessionID: "late_child", status: { type: "busy" } });
  expect(h.view.thread.status.state).toBe("unresponsive");
  expect(Object.values(h.view.agents).map((agent) => agent.status.state)).toEqual([
    "unresponsive",
    "unresponsive",
  ]);
  h.lifecycle("resynced");
  expect(h.view.thread.status.state).toBe("working");
});

it("preserves the native body of a malformed recognized part without an ID", () => {
  const h = setup();
  h.event("message.part.updated", { part: { type: "tool", unknownFuture: "NO_ID_FUTURE" } });
  expect(JSON.stringify(Object.values(h.view.items))).toContain("NO_ID_FUTURE");
});
