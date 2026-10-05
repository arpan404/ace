import { expect, it } from "vitest";
import { manager, ready } from "./testing/support.ts";

it("a suspended H264 capture resumes before a screenshot requests its JPEG pixels", async () => {
  const f = await manager({ FAKE_V2: "1", FAKE_VIDEO: "1" });
  try {
    const state = await ready(f.screen);
    await f.screen.configureStream(state.sessionId, {
      codec: "h264",
      maxWidth: 320,
      maxHeight: 640,
      fps: 60,
      bitrate: 500000,
    });
    const first = Promise.withResolvers<void>();
    const stop = await f.screen.subscribe(state.sessionId, async (frame) => {
      if (frame.header.codec === "h264") first.resolve();
    });
    await first.promise;
    stop();
    const idle = await f.screen.targets();
    expect(idle.windows[0]?.title).toContain("capture:false");
    const image = await f.screen.captureScreenshot(state.sessionId);
    expect(image.header.codec).toBe("jpeg");
    expect(image.payload.toString()).toMatch(/^jpeg-/);
    const after = await f.screen.targets();
    expect(after.windows[0]?.title).toContain("capture:false");
  } finally {
    await f.close();
  }
});

it("controller replacement posts a native cancellation before the new owner's input", async () => {
  const f = await manager({ FAKE_V2: "1" });
  try {
    const state = await ready(f.screen);
    f.screen.controller(state.sessionId, "human", "old");
    await f.screen.input(state.sessionId, "human", { kind: "pointer.down", x: 10, y: 10 }, "old");
    f.screen.controller(state.sessionId, "human", "new");
    await f.screen.input(state.sessionId, "human", { kind: "pointer.move", x: 20, y: 20 }, "new");
    const targets = await f.screen.targets();
    expect(targets.windows[0]?.title).toContain("pointerHeld:false;pointerUps:1");
  } finally {
    await f.close();
  }
});

it("a failed native release blocks new input and is retried on the next takeover", async () => {
  const f = await manager({ FAKE_V2: "1", FAIL_CANCEL_ONCE: "1" });
  try {
    const state = await ready(f.screen);
    f.screen.controller(state.sessionId, "human", "old");
    await f.screen.input(state.sessionId, "human", { kind: "pointer.down", x: 10, y: 10 }, "old");
    f.screen.controller(state.sessionId, "human", "new");
    await expect(
      f.screen.input(state.sessionId, "human", { kind: "pointer.move", x: 20, y: 20 }, "new"),
    ).rejects.toThrow("Cleanup permission revoked");
    f.screen.controller(state.sessionId, "human", "retry");
    await f.screen.input(state.sessionId, "human", { kind: "pointer.move", x: 20, y: 20 }, "retry");
    const targets = await f.screen.targets();
    expect(targets.windows[0]?.title).toContain("pointerHeld:false;pointerUps:1");
  } finally {
    await f.close();
  }
});
