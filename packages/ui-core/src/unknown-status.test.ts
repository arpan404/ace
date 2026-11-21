import { ThreadStatus } from "@ace/protocol";
import { expect, it } from "vitest";
import { mobileStatus } from "./mobile-status.ts";
import { taskPill, threadStatusLabel, threadStatusMark } from "./status.ts";

// A state from a daemon newer than this client, as the shared decoder reads it.
const newer = ThreadStatus.parse({ state: "paused", until: 5 });

it("shows a thread state newer than the client neutrally, never as done, working or new", () => {
  expect(threadStatusLabel(newer)).toEqual({ label: "Status unknown", tone: "idle" });
  expect(threadStatusMark(newer)).toBe("none");
  // Read or not, the row keeps naming it; it never settles into an age like a done thread.
  for (const unread of [true, false])
    expect(taskPill(newer, { unread, since: 0 })).toEqual({
      label: "Status unknown",
      tone: "idle",
      icon: "background",
    });
  expect(mobileStatus(newer)).toEqual({ label: "Status unknown", token: "neutral" });
});
