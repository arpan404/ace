import { z } from "zod";
import { performance } from "node:perf_hooks";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { startRelay, connectHostToRelay, connectClientViaRelay } from "../src/index.ts";
import type { HostChannel } from "../src/index.ts";
const input = z
  .object({
    MESSAGES_PER_SECOND: z.coerce.number().int().positive().default(1000),
    MESSAGE_BURST: z.coerce.number().int().positive().default(2000),
    TOTAL_MIB: z.coerce.number().int().min(1).default(300),
    MESSAGE_MIB: z.coerce.number().int().min(1).max(15).default(1),
  })
  .parse(process.env);
if (input.TOTAL_MIB % input.MESSAGE_MIB !== 0)
  throw new Error("Total must divide into whole messages");
const count = input.TOTAL_MIB / input.MESSAGE_MIB;
const payload = "x".repeat(input.MESSAGE_MIB * 1024 * 1024);
const accepted = Promise.withResolvers<HostChannel>();
const relay = await startRelay({
  limits:
    process.env["UNLIMITED"] === "1"
      ? { messagesPerSecond: 100000, messageBurst: 100000 }
      : { messagesPerSecond: input.MESSAGES_PER_SECOND, messageBurst: input.MESSAGE_BURST },
});
const host = await connectHostToRelay({
  relayUrl: relay.url,
  hostKeys: keyPair(),
  onClientChannel: accepted.resolve,
});
const client = await connectClientViaRelay({
  relayUrl: relay.url,
  hostId: host.hostId,
  pinnedFingerprint: host.hostId,
});
const server = await accepted.promise;
await client.send({
  type: "hello",
  protocolVersion: 1,
  deviceId: DeviceId.parse("bench"),
  token: "bench",
});
await server.receive();
server.authorize();
let peakRss = process.memoryUsage().rss;
async function transfer(messages: number) {
  const receiver = (async () => {
    for (let i = 0; i < messages; i++) {
      const message = await client.receive();
      if (message.type !== "error" || message.message.length !== payload.length)
        throw new Error("Incomplete payload");
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  })();
  for (let i = 0; i < messages; i++)
    await server.send({ type: "error", code: "bench", message: payload });
  await receiver;
}
try {
  await transfer(Math.ceil(16 / input.MESSAGE_MIB));
  const before = process.memoryUsage().rss;
  peakRss = before;
  const cpu = process.cpuUsage();
  const start = performance.now();
  await transfer(count);
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      mode: process.env["UNLIMITED"] === "1" ? "unlimited" : "default",
      messagesPerSecond: process.env["UNLIMITED"] === "1" ? 100000 : input.MESSAGES_PER_SECOND,
      messageBurst: process.env["UNLIMITED"] === "1" ? 100000 : input.MESSAGE_BURST,
      MiB: input.TOTAL_MIB,
      messageMiB: input.MESSAGE_MIB,
      milliseconds: +elapsed.toFixed(2),
      MiBPerSecond: +((input.TOTAL_MIB * 1000) / elapsed).toFixed(2),
      cpuMilliseconds: (used.user + used.system) / 1000,
      baselineRssMiB: +(before / 1048576).toFixed(2),
      peakRssMiB: +(peakRss / 1048576).toFixed(2),
      endingRssMiB: +(process.memoryUsage().rss / 1048576).toFixed(2),
      throttledFrames: relay.stats.throttledFrames,
      relayPeakReaderBytes: relay.stats.peakReaderBytes,
      relayPeakBufferedBytes: relay.stats.peakBufferedBytes,
      pausedReaders: relay.stats.pausedReaders,
    }),
  );
} finally {
  client.close();
  await host.close();
  await relay.close();
}
