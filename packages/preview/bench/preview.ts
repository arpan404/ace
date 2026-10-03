import { benchmarkCreditExhaustedCloses } from "./relay-close.ts";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { startRelay, connectHostToRelay, connectClientViaRelay } from "@ace/relay";
import { performance } from "node:perf_hooks";
import { request } from "node:http";
import { Readable } from "node:stream";
import {
  createPreviewGateway,
  TerminalUrlScanner,
  parseListeningPorts,
  attachPreviewRelay,
  openPreviewProxy,
  createLaunchManager,
  previewRelayChannel,
} from "../src/index.ts";
import { serve, http, channelPair } from "../src/test-support.ts";

// Non-gating measurements. Each phase prints measured throughput and process RSS.
function report(name: string, units: number, start: number, peak: number, baseline: number) {
  const seconds = (performance.now() - start) / 1000;
  console.log(
    JSON.stringify({
      name,
      seconds: Number(seconds.toFixed(3)),
      unitsPerSecond: Math.round(units / seconds),
      peakRssMiB: Number((peak / 1048576).toFixed(1)),
      rssIncreaseMiB: Number(((peak - baseline) / 1048576).toFixed(1)),
    }),
  );
}
async function download(url: string, expectedBytes: number, cookie = ""): Promise<number> {
  const address = new URL(url);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/",
        headers: { host: address.host, cookie },
        agent: false,
      },
      resolve,
    );
    req.once("error", reject);
    req.end();
  });
  if (response.statusCode !== 200)
    throw new Error(`Benchmark received HTTP ${response.statusCode}`);
  let received = 0;
  let peak = process.memoryUsage().rss;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected byte stream");
    received += chunk.length;
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  if (received !== expectedBytes) throw new Error("Benchmark download was incomplete");
  return peak;
}
async function main() {
  const scanner = new TerminalUrlScanner();
  let baseline = process.memoryUsage().rss,
    start = performance.now();
  for (let i = 0; i < 200_000; i++) scanner.feed("Server running http://localhost:3000/app\n");
  report("terminal chunks/s", 200_000, start, process.memoryUsage().rss, baseline);
  const table = Array.from({ length: 1000 }, (_, i) => `n127.0.0.1:${3000 + i}\n`).join("");
  baseline = process.memoryUsage().rss;
  start = performance.now();
  for (let i = 0; i < 1000; i++) parseListeningPorts(table, "lsof");
  report("listener rows/s", 1_000_000, start, process.memoryUsage().rss, baseline);

  baseline = process.memoryUsage().rss;
  start = performance.now();
  const launches = createLaunchManager({ root: process.cwd() });
  const { PreviewLaunch } = await import("@ace/protocol/preview");
  const output = await launches.start(
    PreviewLaunch.parse({
      name: "output-bench",
      command: process.execPath,
      args: ["-e", "process.stdout.write(('x'.repeat(1023)+'\\n').repeat(10240))"],
    }),
  );
  await output.process?.exited;
  report(
    "supervised output bytes/s, 10 MiB",
    10 * 1024 * 1024,
    start,
    process.memoryUsage().rss,
    baseline,
  );
  await launches.close();

  const upstream = await serve((_req, res) => res.end("preview"));
  const g = await createPreviewGateway({
    host: "127.0.0.1",
    wildcardHost: "preview.test",
    authority: { authorize: async () => "bench", isPaired: async () => true },
  });
  const origin = g.register({ port: upstream.port });
  const login = await http(await g.mintLink({ port: upstream.port, deviceToken: "bench" }));
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
  try {
    baseline = process.memoryUsage().rss;
    start = performance.now();
    let peak = baseline;
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 100 }, () => http(origin, { cookie })));
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    report("gateway requests/s, concurrency 100", 1000, start, peak, baseline);
  } finally {
    await g.close();
    await upstream.close();
  }

  baseline = process.memoryUsage().rss;
  start = performance.now();
  const closePeak = await benchmarkCreditExhaustedCloses(1000);
  report("relay credit-exhausted closes/s, native I/O edge", 1000, start, closePeak, baseline);

  const size = 50 * 1024 * 1024;
  const large = await serve((_req, res) =>
    Readable.from(
      (function* () {
        const chunk = Buffer.alloc(65_536);
        for (let n = 0; n < size; n += 65_536) yield chunk;
      })(),
    ).pipe(res),
  );
  const streaming = await createPreviewGateway({
    host: "127.0.0.1",
    wildcardHost: "preview.test",
    authority: { authorize: async () => "bench", isPaired: async () => true },
  });
  const largeOrigin = streaming.register({ port: large.port });
  const token = await http(await streaming.mintLink({ port: large.port, deviceToken: "bench" }));
  const session = token.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
  try {
    // Use a streamed client; the benchmark never accumulates the download.
    baseline = process.memoryUsage().rss;
    start = performance.now();
    let peak = baseline;
    peak = await download(largeOrigin, size, session);
    report("gateway streamed bytes/s, 50 MiB", size, start, peak, baseline);
  } finally {
    await streaming.close();
  }

  const channels = channelPair();
  const host = attachPreviewRelay({
    channel: channels.b,
    allowPort: async (port) => port === large.port,
  });
  const client = await openPreviewProxy({ channel: channels.a, port: large.port });
  try {
    baseline = process.memoryUsage().rss;
    start = performance.now();
    const peak = await download(client.url, size);
    report("relay streamed bytes/s, 50 MiB", size, start, peak, baseline);
  } finally {
    await client.close();
    host.close();
  }
  const relay = await startRelay({ limits: { messagesPerSecond: 100_000, messageBurst: 200_000 } });
  const deviceToken = "b".repeat(64);
  const registration = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    async onClientChannel(channel) {
      const hello = await channel.receive();
      if (hello.type !== "hello" || hello.token !== deviceToken)
        throw new Error("Unpaired benchmark device");
      channel.authorize();
      attachPreviewRelay({
        channel: previewRelayChannel(channel),
        allowPort: async (port) => port === large.port,
      });
      await channel.send({ type: "pong" });
    },
  });
  const encrypted = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: registration.hostId,
    pinnedFingerprint: registration.hostId,
  });
  await encrypted.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("bench"),
    token: deviceToken,
  });
  await encrypted.receive();
  const encryptedProxy = await openPreviewProxy({
    channel: previewRelayChannel(encrypted),
    port: large.port,
  });
  try {
    baseline = process.memoryUsage().rss;
    start = performance.now();
    const peak = await download(encryptedProxy.url, size);
    report("encrypted relay streamed bytes/s, 50 MiB", size, start, peak, baseline);
  } finally {
    await encryptedProxy.close();
    await registration.close();
    await relay.close();
    await large.close();
  }
}
await main();
