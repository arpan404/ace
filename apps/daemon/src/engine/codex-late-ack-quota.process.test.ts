import { expect, test } from "vitest";
import { createCodexAdapter } from "@ace/adapter-codex";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame } from "@ace/engine-api";
import { Engine } from "@ace/daemon";
import { harness, scriptFrames } from "./test-support.ts";

test("a quota completion before acknowledgement pauses the durable queue across restart", async () => {
  let seq = 0;
  const frame = (data: unknown, dir: Frame["dir"] = "recv"): Frame => {
    const payload = new ProviderPayload(JSON.stringify(data));
    return { seq: ++seq, t: seq, dir, channel: "stdio", data: payload.data, payload };
  };
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frame({ method: "thread/started", params: { thread: { id: "native" } } }),
          frame({ method: "turn/started", params: { threadId: "native", turn: { id: "A" } } }),
          frame({
            method: "turn/completed",
            params: { threadId: "native", turn: { id: "A", status: "completed" } },
          }),
        ],
      },
    ],
    scriptFrames(),
    { createTranslator: createCodexAdapter().createTranslator },
  );
  let reopened: Engine | undefined;
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider session");
    context.onFrame(
      frame({ id: 70, method: "turn/start", params: { threadId: "native" } }, "send"),
    );
    context.onFrame(
      frame({
        method: "turn/completed",
        params: {
          threadId: "native",
          turn: {
            id: "B",
            status: "failed",
            error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
          },
        },
      }),
    );
    context.onFrame(frame({ id: 70, result: { turn: { id: "B" } } }));
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("limited");
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
    await h.engine.close();
    reopened = new Engine(h.store, { registry: h.registry, clock: h.clock });
    await reopened.flush();
    expect(h.store.getThread(id)?.status.state).toBe("limited");
    expect(reopened.queue(id)).toMatchObject({ paused: true, reason: "limit" });
  } finally {
    await reopened?.close();
    await h.close();
  }
});
