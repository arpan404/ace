import { expect, test } from "vitest";
import { fixture } from "./socket-test-support.ts";

test("a daemon without a helper finishes the screen refresh with an unavailable status and an empty session list", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "screen.request", requestId: "status", operation: { op: "status" } });
    expect(await client.next()).toMatchObject({
      type: "screen.result",
      ok: false,
      errorCode: "screen_disabled",
    });
    client.send({ type: "screen.request", requestId: "sessions", operation: { op: "sessions" } });
    expect(await client.next()).toMatchObject({
      type: "screen.result",
      requestId: "sessions",
      ok: true,
      data: [],
    });
    client.send({
      type: "screen.request",
      requestId: "permissions",
      operation: { op: "permissions" },
    });
    expect(await client.next()).toMatchObject({
      type: "screen.result",
      ok: false,
      errorCode: "screen_disabled",
    });
  } finally {
    await f.close();
  }
});
