import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { startRelay, connectHostToRelay } from "@ace/relay";
import { keyPair, fingerprint } from "@ace/secure-channel";
import { HostId } from "@ace/protocol";
import { DeviceClient, deviceTransport } from "../src/index.ts";

// Non-gating authenticated transport benchmark; run only when the owner permits it.
const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
const hostKeys = keyPair(new Uint8Array(32).fill(8));
const hostId = HostId.parse(fingerprint(hostKeys.publicKey));
const host = await connectHostToRelay({
  relayUrl: relay.url,
  hostKeys,
  async onClientChannel(channel) {
    const hello = await channel.receive();
    if (hello.type !== "hello" || hello.channel !== "devices")
      throw new Error("Missing device hello");
    channel.authorize();
    await channel.send({ type: "welcome", protocolVersion: 1, hostId, headSeq: 0 });
    for await (const message of channel) {
      if (message.type === "devices.request")
        await channel.send({
          type: "devices.result",
          requestId: message.requestId,
          ok: true,
          data: { devices: [], issues: [] },
        });
      else if (message.type === "ping") await channel.send({ type: "pong" });
    }
  },
});
const schedule = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};
let request = 0;
const client = new DeviceClient({ id: () => `benchmark-${++request}`, schedule });
try {
  const ready = Promise.withResolvers<void>();
  const unwatch = client.watch((state) => {
    if (state.connected) ready.resolve();
  });
  client.connect(
    deviceTransport({
      target: { kind: "relay", url: relay.url, pinnedFingerprint: hostId },
      deviceId: "benchmark",
      credential: async () => "a".repeat(64),
      schedule,
      socket: (url) => new WebSocket(url),
      keys: () => ({
        staticKey: keyPair(new Uint8Array(32).fill(3)),
        ephemeralKey: keyPair(new Uint8Array(32).fill(4)),
      }),
    }),
  );
  await ready.promise;
  unwatch();
  const count = 2000;
  const started = performance.now();
  for (let index = 0; index < count; index++) await client.request({ op: "list" });
  const elapsed = performance.now() - started;
  process.stdout.write(
    `authenticated relay device round trip: ${((count / elapsed) * 1000).toFixed(0)} ops/s, ${((elapsed * 1000) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
} finally {
  client.disconnect();
  host.close();
  await relay.close();
}
