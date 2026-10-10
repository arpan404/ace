import { expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";

test("an authenticated client sees startup progress before the services can welcome it", async () => {
  const ready = Promise.withResolvers<void>();
  const f = await fixture({ ready: ready.promise });
  try {
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("cold-start"),
      token,
    });
    expect(await client.next()).toEqual({ type: "starting" });
    ready.resolve();
    expect(await client.next()).toMatchObject({ type: "welcome", hostId: "host" });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  } finally {
    ready.resolve();
    await f.close();
  }
});
