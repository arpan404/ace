/**
 * The longest the event loop stalls while a relay channel deflates and sends one large JSON
 * message, against the synchronous deflate a channel used to run for it. A local relay and the
 * host channel run here; the reading client runs in a child process, so its inflate doesn't
 * land on this event loop. One line per size. Local only.
 *
 *   bun apps/relay/scripts/measure-deflate-gap.ts [MiB…]
 */
import { deflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "../src/index.ts";
import { deflateLater } from "../src/channel.ts";
import type { HostChannel } from "../src/index.ts";

// The child: dial the relay, say hello, read messages and report each one's length.
if (process.argv[2] === "--client") {
  const [relayUrl, hostId] = process.argv.slice(3);
  if (!relayUrl || !hostId) throw new Error("Expected relay URL and host id");
  const client = await connectClientViaRelay({ relayUrl, hostId, pinnedFingerprint: hostId });
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    compression: ["deflate-raw"],
  });
  for (;;) {
    const text = await client.receiveRaw();
    process.stdout.write(`${text.length}\n`);
  }
}

const sizes = process.argv.slice(2).map(Number);
if (sizes.length === 0) sizes.push(2, 8);

/** Runs `work` and reports the longest gap between event-loop turns meanwhile. */
async function longestGap(work: () => unknown): Promise<number> {
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  longest = 0;
  last = performance.now();
  await work();
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(timer);
  return longest;
}

const relay = await startRelay();
const arrived = Promise.withResolvers<HostChannel>();
const host = await connectHostToRelay({
  relayUrl: relay.url,
  hostKeys: keyPair(),
  onClientChannel: arrived.resolve,
});
const child = spawn(process.execPath, [import.meta.filename, "--client", relay.url, host.hostId], {
  stdio: ["ignore", "pipe", "inherit"],
});
const received: (() => void)[] = [];
child.stdout.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n")) if (line) received.shift()?.();
});
const server = await arrived.promise;
await server.receive();
server.authorize();
/** Transcript-like JSON of about `mib` MiB: repetitive, so it deflates well. */
function transcript(mib: number): string {
  const items = Array.from({ length: Math.ceil((mib * 1024 * 1024) / 52) }, (_, index) => ({
    id: `item-${index}`,
    text: `line ${index} of output ${index % 97}`,
  }));
  return JSON.stringify({ type: "pong", items });
}
const send = async (text: string) => {
  const reading = new Promise<void>((resolve) => received.push(resolve));
  await server.sendText(text, true);
  await reading;
};
const median = (values: number[]) =>
  values.toSorted((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;
// Warm the send path (encryption, sockets) once, unmeasured.
await send(transcript(2));
const runs = 5;
const idle: number[] = [];
for (let run = 0; run < runs; run++)
  idle.push(await longestGap(() => new Promise((resolve) => setTimeout(resolve, 50))));
console.log(`idle: longest event-loop gap ${median(idle).toFixed(1)} ms (median of ${runs})`);
for (const mib of sizes) {
  const text = transcript(mib);
  const json = new TextEncoder().encode(text);
  const before: number[] = [];
  const alone: number[] = [];
  const took: number[] = [];
  const after: number[] = [];
  for (let run = 0; run < runs; run++) {
    before.push(await longestGap(() => deflateRawSync(json, { level: 6 })));
    // The channel's own deflate by itself: how long it takes, and how long the loop stalls.
    alone.push(
      await longestGap(async () => {
        const start = performance.now();
        await deflateLater(json);
        took.push(performance.now() - start);
      }),
    );
    after.push(await longestGap(() => send(text)));
  }
  console.log(
    `${mib} MiB: the channel's own deflate takes ${median(took).toFixed(1)} ms; ` +
      `the event loop's longest gap meanwhile ${median(alone).toFixed(1)} ms`,
  );
  console.log(
    `${mib} MiB (${json.length} bytes): synchronous deflate stalls ${median(before).toFixed(1)} ms; ` +
      `sent through the channel now, longest gap ${median(after).toFixed(1)} ms (medians of ${runs})`,
  );
}
child.kill();
await host.close();
await relay.close();
process.exit(0);
