import { expect, it } from "vitest";
import { harness } from "./replay.ts";

function setup() {
  const h = harness();
  let seq = 0;
  const event = (type: string, data: Record<string, unknown> = {}) =>
    h.feed({
      seq: seq++,
      t: seq,
      dir: "recv",
      channel: "sse",
      data: {
        id: `e${seq}`,
        created: seq,
        type,
        data: { sessionID: "s-root", ...data },
        location: { directory: "/one" },
      },
    });
  h.feed({ seq: seq++, t: seq, dir: "note", channel: "lifecycle", data: { type: "started" } });
  event("session.created", { projectID: "p", location: { directory: "/one" } });
  return { ...h, event };
}

const openItems = (h: ReturnType<typeof setup>) =>
  Object.values(h.view.items).filter(
    (item) => (item.type === "reasoning" || item.type === "message") && !item.complete,
  );

it("an interrupted execution leaves no thought or reply still streaming", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.reasoning.started", { assistantMessageID: "a", ordinal: 0, text: "" });
  h.event("session.reasoning.ended", { assistantMessageID: "a", ordinal: 0, text: "Plan" });
  // OpenCode stops mid-thought and mid-reply: neither ever gets its ended event.
  h.event("session.reasoning.started", { assistantMessageID: "b", ordinal: 0, text: "" });
  h.event("session.text.started", { assistantMessageID: "b", ordinal: 0, text: "" });
  h.event("session.text.delta", { assistantMessageID: "b", ordinal: 0, delta: "Final rev" });
  expect(openItems(h)).toHaveLength(2);
  h.event("session.execution.interrupted");
  expect(Object.values(h.view.runs).map((run) => run.state)).toEqual(["interrupted"]);
  expect(openItems(h)).toEqual([]);
  // What streamed before the stop is kept.
  expect(
    Object.values(h.view.items).flatMap((item) =>
      item.type === "message" ? item.parts.map((part) => part.type === "text" && part.text) : [],
    ),
  ).toEqual(["Final rev"]);
});

it("a failed execution closes its open thought too", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.reasoning.started", { assistantMessageID: "a", ordinal: 0, text: "" });
  h.event("session.execution.failed", { error: { message: "internal server error" } });
  expect(openItems(h)).toEqual([]);
});

it("a thought from the next execution stays live after the previous one ended", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  h.event("session.execution.started");
  h.event("session.reasoning.started", { assistantMessageID: "c", ordinal: 0, text: "" });
  expect(openItems(h)).toHaveLength(1);
  expect(h.view.thread.status.state).toBe("working");
});
