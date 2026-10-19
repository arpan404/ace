import { Event, Thread, type EventPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import { applyEvent, createThreadView } from "./index.ts";

const thread = Thread.parse({
  id: "t",
  workspaceId: "w",
  title: "Title",
  provider: "codex",
  status: { state: "new" },
  createdAt: 1,
  updatedAt: 1,
});

function fold(payloads: EventPayload[]) {
  const view = createThreadView(thread);
  payloads.forEach((payload, index) =>
    applyEvent(
      view,
      Event.parse({ seq: index + 1, id: `e${index + 1}`, threadId: "t", at: index + 1, payload }),
    ),
  );
  return view.thread;
}

test("a thread remembers every provider it ran on, oldest first, each once", () => {
  const moved = fold([
    { type: "thread.updated", provider: "claude" },
    { type: "thread.updated", provider: "opencode" },
    { type: "thread.updated", provider: "codex" },
  ]);
  expect(moved.provider).toBe("codex");
  expect(moved.providers).toEqual(["claude", "opencode", "codex"]);
});

test("a thread that never changes provider records no history", () => {
  const stayed = fold([
    { type: "thread.updated", title: "Renamed" },
    { type: "thread.updated", provider: "codex" },
  ]);
  expect(stayed.providers).toBeUndefined();
});
