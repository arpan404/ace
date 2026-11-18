import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import type { Credential } from "./credentials.ts";
import { Connection } from "./connection.ts";
import { defaultLimits } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** The hello a connection sends with `credential`, on a socket that opens at once. */
async function helloWith(credential: Credential): Promise<Record<string, unknown>> {
  const hellos: Record<string, unknown>[] = [];
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("desktop-page"),
      transport: () => ({
        open(events) {
          events.open();
        },
        send(text) {
          const message = JSON.parse(text) as Record<string, unknown>;
          if (message.type === "hello") hellos.push(message);
        },
        close() {},
      }),
      credential: async () => credential,
      storage: { load: async () => null, save: async () => {} },
      scheduler: { set: () => () => {} },
      random: () => 0.5,
      id: () => "id",
      now: () => 0,
      monotonic: () => 0,
    },
    new WireCodec(),
    defaultLimits,
    () => {},
    () => {},
    () => {},
  );
  connection.start();
  for (let i = 0; i < 10 && hellos.length === 0; i++) await Promise.resolve();
  connection.stop();
  const hello = hellos[0];
  if (!hello) throw new Error("No hello");
  return hello;
}

const token = "a".repeat(64);

test("the desktop app's page says hello with the host token and its app proof", async () => {
  const appProof = "p".repeat(43);
  expect(await helloWith({ token, appProof })).toMatchObject({ token, appProof });
});

test("any other host-token client says hello with the token alone", async () => {
  const hello = await helloWith(token);
  expect(hello).toMatchObject({ token });
  expect(hello).not.toHaveProperty("appProof");
});
