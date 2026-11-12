/**
 * How much the relay object holds for a device that stops reading (ADR 0110). Runs the Worker
 * under Miniflare, pairs a daemon channel with a device channel, sends `MB` megabytes from the
 * daemon while the device reads nothing for three seconds, then lets it read. Prints workerd's
 * resident memory before, while stalled and at peak, and whether every byte arrived.
 *
 *   node apps/cloud/scripts/measure-slow-reader.ts [MB] [--flow] [--no-stall]
 *
 * `--flow` turns credit flow control on (as a device whose hello asks for it); `--no-stall`
 * reads from the start, for the cost of throughput alone. Local only: no Cloudflare calls.
 */
import { execFileSync } from "node:child_process";
import { DeviceId } from "@ace/protocol";
import { hostId, keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { deferred } from "@ace/relay/testing";
import { launchWorker } from "../src/testing/worker.ts";
import { mint } from "../src/testing/harness.ts";

const totalMb = Number(process.argv[2] ?? 64);
const flow = process.argv.includes("--flow");
const stall = !process.argv.includes("--no-stall");
function workerdRss(): number {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="]).toString();
  let rss = 0;
  const kids = new Set([process.pid]);
  for (let round = 0; round < 4; round++)
    for (const line of out.trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/);
      if (kids.has(Number(ppid))) kids.add(Number(pid));
    }
  for (const line of out.trim().split("\n")) {
    const [pid, , kb, ...cmd] = line.trim().split(/\s+/);
    if (Number(pid) !== process.pid && kids.has(Number(pid)) && cmd.join(" ").includes("workerd"))
      rss += Number(kb);
  }
  return Math.round(rss / 1024);
}
const worker = await launchWorker();
const hostKeys = keyPair();
const next = deferred<HostChannel>();
const connection = await connectHostToRelay({
  relayUrl: worker.relayUrl,
  hostKeys,
  account: { grant: async () => mint("machine", "user_a", hostId(hostKeys.publicKey)) },
  onClientChannel: (c) => next.resolve(c),
});
const client = await connectClientViaRelay({
  relayUrl: worker.relayUrl,
  hostId: connection.hostId,
  pinnedFingerprint: connection.hostId,
  grant: mint("device", "user_a", "phone"),
});
const server = await next.promise;
await client.send({
  type: "hello",
  protocolVersion: 1,
  deviceId: DeviceId.parse("phone"),
  token: "t",
});
await server.receive();
server.authorize();
if (flow) server.flowControl?.();
await server.send({ type: "pong" });
await client.receive();
console.log(`workerd rss before: ${workerdRss()} MB`);
const chunk = new Uint8Array(60 * 1024).fill(7);
const started = Date.now();
let sent = 0;
const sampler = setInterval(
  () =>
    console.log(
      `t=${Date.now() - started}ms sent=${(sent / 2 ** 20).toFixed(1)}MB daemonQueued=${server.bufferedBytes} workerd=${workerdRss()}MB`,
    ),
  1000,
);
let failure: unknown;
let peak = 0;
const peakSampler = setInterval(() => (peak = Math.max(peak, workerdRss())), 250);
try {
  const sending = (async () => {
    while (sent < totalMb * 2 ** 20) {
      await server.sendBinary(chunk);
      sent += chunk.length;
    }
  })();
  // With flow control the sender waits for the reader; give it 3 s, then let the reader go.
  await Promise.race([sending, new Promise((r) => setTimeout(r, stall ? 3000 : 0))]);
} catch (error) {
  failure = error;
}
console.log(
  `daemon finished sending ${(sent / 2 ** 20).toFixed(1)} MB in ${Date.now() - started} ms; error=${failure}`,
);
await new Promise((r) => setTimeout(r, 3000));
console.log(
  `workerd rss after send, reader still stalled: ${workerdRss()} MB; client buffered=${client.bufferedReceiveBytes}`,
);
// Now the reader drains; does everything arrive in order?
let received = 0;
const drainStart = Date.now();
try {
  while (received < totalMb * 2 ** 20) {
    const frame = await Promise.race([
      client.receiveBinary(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("drain timeout")), 10000)),
    ]);
    received += frame.length;
  }
} catch (error) {
  console.log(`drain error: ${error}`);
}
clearInterval(peakSampler);
console.log(`peak workerd rss: ${peak} MB`);
console.log(
  `client drained ${(received / 2 ** 20).toFixed(1)} MB in ${Date.now() - drainStart} ms; workerd=${workerdRss()} MB`,
);
clearInterval(sampler);
client.close();
await connection.close();
await worker.close();
process.exit(0);
