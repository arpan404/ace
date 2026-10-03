import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { DeviceId } from "@ace/protocol";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { attachFilesRelay, CHUNK_SIZE, decodeFileFrame } from "../src/index.ts";
import { fixture } from "../src/test-support.ts";

const f = await fixture();
const size = 32 * 1024 ** 2;
const file = await open(join(f.root, "binary"), "w");
await file.truncate(size);
await file.close();
const relay = await startRelay();
const host = await connectHostToRelay({
  relayUrl: relay.url,
  hostKeys: keyPair(),
  async onClientChannel(channel) {
    const hello = await channel.receive();
    if (hello.type !== "hello" || hello.token !== "bench") {
      channel.close();
      return;
    }
    channel.authorize();
    const session = attachFilesRelay(f.service, channel, hello.deviceId, () => true);
    try {
      for await (const frame of channel.frames()) {
        if (frame instanceof Uint8Array)
          session.binary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
        else session.accept(frame);
      }
    } finally {
      session.close();
    }
  },
});
const client = await connectClientViaRelay({
  relayUrl: relay.url,
  hostId: host.hostId,
  pinnedFingerprint: host.hostId,
});
try {
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("bench"),
    token: "bench",
  });
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "download", path: "binary", offset: 0 },
  });
  const ready = z.object({ channel: z.number() }).parse(await client.receive());
  const before = process.memoryUsage().rss;
  const start = performance.now();
  const digest = createHash("sha256");
  let bytes = 0;
  while (bytes < size) {
    await client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
    const frame = decodeFileFrame(
      Buffer.from(z.instanceof(Uint8Array).parse(await client.receiveFrame())),
    );
    if (frame.offset !== bytes) throw new Error("Wrong offset");
    bytes += frame.bytes.length;
    digest.update(frame.bytes);
  }
  const end = await client.receive();
  if (end.type !== "files.end" || end.sha256 !== digest.digest("hex"))
    throw new Error("Invalid trailer");
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      mode: "encrypted relay",
      MiB: size / 1024 ** 2,
      MiBPerSecond: size / 1024 ** 2 / (elapsed / 1000),
      framesPerSecond: size / CHUNK_SIZE / (elapsed / 1000),
      combinedPeakRssMiB: process.resourceUsage().maxRSS / 1024,
      combinedRssGrowthMiB: (process.memoryUsage().rss - before) / 1024 ** 2,
      relayPeakReaderBytes: relay.stats.peakReaderBytes,
      relayPeakBufferedBytes: relay.stats.peakBufferedBytes,
    }),
  );
} finally {
  client.close();
  await host.close();
  await relay.close();
  await f.close();
}
