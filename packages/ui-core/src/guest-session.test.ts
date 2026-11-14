import type { ThreadStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { guestSession } from "./guest-session.ts";

const guest = { host: "linux-box", name: "Linux box" };

test("a thread with no guest session has none", () => {
  expect(guestSession({ status: { state: "working", agents: 1 } })).toBeUndefined();
  expect(guestSession(undefined)).toBeUndefined();
});

test.each<[string, ThreadStatus | undefined, boolean]>([
  ["a call from there runs in the background", { state: "waiting", on: "background_task" }, true],
  ["it works", { state: "working", agents: 1 }, true],
  ["it waits for the person", { state: "needs_you", interactions: 1 }, true],
  ["it is done", { state: "done" }, false],
  ["it has not started", { state: "new" }, false],
  ["its status is unknown", undefined, false],
])(
  "while %s, the line says whose work it is, with Stop only while it works",
  (_, status, working) => {
    const session = guestSession({ details: { guest }, status });
    expect(session?.working).toBe(working);
    expect(session?.line).toBe(
      working
        ? "Used by agents on Linux box. Stop to end their work."
        : "Used by agents on Linux box.",
    );
  },
);

test("a calling machine without a name is named by its host", () => {
  const session = guestSession({ details: { guest: { host: "linux-box", name: "" } } });
  expect(session?.machine).toBe("linux-box");
  expect(session?.line).toBe("Used by agents on linux-box.");
});
