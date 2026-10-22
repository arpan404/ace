import { native } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { PatchPump } from "./patch-pump.ts";

afterEach(() => {
  native.frames.length = 0;
  native.ack = () => {};
});

test("a transcript reaches the phone while the inbox keeps changing", async () => {
  const pump = new PatchPump();
  native.ack = (accepted) => pump.ack(accepted);
  // A busy inbox: forty rows that change again before every frame is acknowledged.
  let revision = 0;
  const churn = () => {
    revision++;
    for (let row = 0; row < 40; row++)
      pump.put(`inbox:t${row}`, () => ({ type: "inbox.row", id: `t${row}`, revision }));
  };
  const emit = globalThis.aceHost.emit;
  globalThis.aceHost.emit = (frame: string) => {
    churn();
    emit(frame);
  };
  try {
    churn();
    pump.put("thread:ready", () => ({ type: "thread.ready", threadId: "a", epoch: 1, count: 2 }));
    for (let wait = 0; wait < 40 && !native.frames.some((p) => p.type === "thread.ready"); wait++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.frames.some((patch) => patch.type === "thread.ready")).toBe(true);
    // Status still leads: the frame that carried the transcript began with inbox rows.
    const index = native.frames.findIndex((patch) => patch.type === "thread.ready");
    expect(native.frames[index - 1]?.type).toBe("inbox.row");
  } finally {
    globalThis.aceHost.emit = emit;
  }
});
