import { afterEach, expect, it } from "vitest";
import { keyPair, NoiseXX } from "@ace/secure-channel";
import { startRelay } from "./index.ts";
import { ManualClock } from "./testing/clock.ts";
import {
  openPeer,
  address,
  CONTROL,
  Registration,
  json,
  deferred,
  register,
} from "./testing/peer.ts";
const noop = () => {};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).toReversed()) await finish();
});
it("binary frames wait for a shared IP token instead of closing a busy stream", async () => {
  const clock = new ManualClock();
  const throttled = deferred<"throttled">();
  const relay = await startRelay({
    clock,
    limits: { messageBurst: 1, messagesPerSecond: 1 },
    onThrottle: () => throttled.resolve("throttled"),
  });
  cleanup.push(() => relay.close());
  const first = await openPeer(address(relay.url, "/host"));
  cleanup.push(() => first.close());
  const noise = new NoiseXX({
    ephemeralKey: keyPair(),
    initiator: true,
    staticKey: keyPair(),
    prologue: CONTROL,
  });
  await first.send(noise.writeMessage());
  noise.readMessage(await first.next());
  await first.send(noise.writeMessage());
  const registered = first
    .next()
    .then((frame) => Registration.parse(json(noise.transport.receive.decrypt(frame))));
  expect(await Promise.race([throttled.promise, registered])).toBe("throttled");
  clock.advance(1000);
  expect(await registered).toMatchObject({ type: "registered" });
});
it("WebSocket pings share the binary-frame IP budget and resume after refill", async () => {
  const clock = new ManualClock();
  let onThrottle = noop;
  const relay = await startRelay({
    clock,
    limits: { messageBurst: 2, messagesPerSecond: 1 },
    onThrottle: () => onThrottle(),
  });
  cleanup.push(() => relay.close());
  const host = await register(relay.url);
  cleanup.push(() => host.close());
  const other = await openPeer(address(relay.url, "/host"));
  cleanup.push(() => other.close());
  const waiting = deferred<"throttled">();
  onThrottle = () => waiting.resolve("throttled");
  const pong = new Promise<"pong">((resolve) => other.socket.once("pong", () => resolve("pong")));
  other.socket.ping();
  expect(await Promise.race([waiting.promise, pong])).toBe("throttled");
  clock.advance(1000);
  expect(await pong).toBe("pong");
  const again = deferred<"throttled">();
  onThrottle = () => again.resolve("throttled");
  const hostPong = new Promise<"pong">((resolve) =>
    host.socket.once("pong", () => resolve("pong")),
  );
  host.socket.ping();
  expect(await Promise.race([again.promise, hostPong])).toBe("throttled");
  clock.advance(1000);
  expect(await hostPong).toBe("pong");
});
