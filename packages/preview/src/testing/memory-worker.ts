import { createServer, request } from "node:http";
import { Readable } from "node:stream";
import { createPreviewGateway } from "../index.ts";

// Run in a fresh Node process with --expose-gc. Retained buffers are a memory
// assertion; RSS and GC timing are deliberately not gating performance budgets.
const upstream = createServer((_req, res) => {
  const chunk = Buffer.alloc(65_536, 3);
  Readable.from(
    (function* () {
      for (let n = 0; n < 50 * 1024 * 1024; n += chunk.length) yield chunk;
    })(),
  ).pipe(res);
});
await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("No upstream address");
const gateway = await createPreviewGateway({
  host: "127.0.0.1",
  wildcardHost: "preview.test",
  authority: { authorize: async () => "memory-test", isPaired: async () => true },
});
try {
  const origin = gateway.register({ port: address.port });
  const link = new URL(await gateway.mintLink({ port: address.port, deviceToken: "memory-test" }));
  const login = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: gateway.port,
        path: link.pathname + link.search,
        headers: { host: link.host },
        agent: false,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
  login.resume();
  if (!globalThis.gc) throw new Error("Memory verification requires --expose-gc");
  globalThis.gc();
  const baseline = process.memoryUsage().arrayBuffers;
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: gateway.port,
        headers: { host: new URL(origin).host, cookie },
        agent: false,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  let received = 0,
    nextSample = 1_048_576,
    peakRetained = baseline;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected byte stream");
    received += chunk.length;
    if (received >= nextSample) {
      globalThis.gc();
      // Native Buffer finalizers run between event-loop turns.
      await new Promise<void>((done) => setImmediate(done));
      globalThis.gc();
      peakRetained = Math.max(peakRetained, process.memoryUsage().arrayBuffers);
      nextSample += 1_048_576;
    }
  }
  console.log(JSON.stringify({ received, retainedBufferIncrease: peakRetained - baseline }));
} finally {
  await gateway.close();
  await new Promise<void>((done) => upstream.close(() => done()));
}
