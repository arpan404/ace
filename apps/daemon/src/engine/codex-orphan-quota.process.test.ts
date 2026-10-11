import { expect, test } from "vitest";
import { createCodexAdapter } from "@ace/adapter-codex";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame } from "@ace/engine-api";
import { harness, scriptFrames } from "./test-support.ts";
import { Engine } from "@ace/daemon";

test("a delayed orphaned Codex quota end cannot pause the durable queue after success", async () => {
  let seq = 0;
  const frame = (data: unknown): Frame => {
    const payload = new ProviderPayload(JSON.stringify(data));
    return { seq: ++seq, t: seq, dir: "recv", channel: "stdio", data: payload.data, payload };
  };
  const boundary = (method: string, id: string, status?: string) =>
    frame({ method, params: { threadId: "native", turn: { id, status } } });
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frame({ method: "thread/started", params: { thread: { id: "native" } } }),
          boundary("turn/started", "new"),
          boundary("turn/completed", "new", "completed"),
        ],
      },
    ],
    scriptFrames(),
    { createTranslator: createCodexAdapter().createTranslator },
  );
  let reopened: Engine | undefined;
  try {
    const id = await h.create();
    h.contexts[0]?.onFrame(
      frame({
        method: "turn/completed",
        params: {
          threadId: "native",
          turn: {
            id: "old",
            status: "failed",
            error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
          },
        },
      }),
    );
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(h.engine.queue(id)).toMatchObject({ paused: false, reason: null });
    await h.engine.close();
    reopened = new Engine(h.store, { registry: h.registry, clock: h.clock });
    await reopened.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(reopened.queue(id)).toMatchObject({ paused: false, reason: null });
  } finally {
    await reopened?.close();
    await h.close();
  }
});
