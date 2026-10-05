import { request } from "node:http";
import { expect, test } from "vitest";
import { fixture, token } from "./socket-test-support.ts";
import { ManualClock } from "./engine/test-support.ts";

test("paused authenticated HTTP downloads expire and release every admission slot", async () => {
  const clock = new ManualClock();
  let reads = 0;
  const { promise: saturated, resolve: filled } = Promise.withResolvers<void>();
  const f = await fixture({
    runtime: { delay: clock.setTimer },
    context: {
      handle: async (_device, message) => ({
        type: "context.result",
        requestId: message.requestId,
        result: { kind: "error", code: "unsupported", message: "unused" },
      }),
      readAttachment: async (_device, _thread, _hash, _variant, offset, limit) => {
        if (offset === 0 && ++reads === 8) filled();
        return {
          mimeType: "application/octet-stream",
          bytes: 32 * 1024 * 1024,
          data: Buffer.alloc(limit),
        };
      },
    },
  });
  const consumers: ReturnType<typeof request>[] = [];
  try {
    const url = `${f.server.httpUrl}/v1/attachments/${f.thread.id}/${"1".repeat(64)}/original`;
    for (let i = 0; i < 8; i++) {
      const consumer = request(
        url,
        { headers: { Authorization: `Bearer ${token}` } },
        (response) => {
          response.pause();
          response.on("error", () => {});
        },
      );
      consumer.on("error", () => {});
      consumers.push(consumer);
      consumer.end();
    }
    await saturated;
    const head = () =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          url,
          { method: "HEAD", headers: { Authorization: `Bearer ${token}` } },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await head()).toBe(429);
    // The following public HEAD request observes admission after the injected deadline.
    clock.advance(31_000);
    expect(await head()).toBe(200);
  } finally {
    for (const consumer of consumers) consumer.destroy();
    await f.close();
  }
});
