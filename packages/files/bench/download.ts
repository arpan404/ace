import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CHUNK_SIZE, decodeFileFrame, encodeFileFrame } from "../src/index.ts";
import { isolated, type Client } from "../src/test-support.ts";

const Ready = z.object({ channel: z.number(), size: z.number().nullable() });
const Upload = z.object({ channel: z.number(), uploadId: z.string(), offset: z.number() });
const Metrics = z.object({ rss: z.number(), peak: z.number() });
async function metrics(client: Client) {
  client.send({ type: "test.metrics" });
  return Metrics.parse(await client.next());
}
const home = await mkdtemp(join(tmpdir(), "ace-transfer-bench-"));
const root = join(home, "workspace");
await mkdir(root);
try {
  const large = await open(join(root, "binary"), "w");
  const binary = randomBytes(CHUNK_SIZE);
  for (let offset = 0; offset < 200 * 1024 * 1024; offset += binary.length)
    await large.write(binary);
  await large.close();
  const small = await open(join(root, "slow"), "w");
  await small.truncate(32 * 1024 * 1024);
  await small.close();
  for (const mode of ["local", "slow", "archive", "upload"] as const) {
    const server = await isolated(root, join(home, mode));
    try {
      const client = server.client;
      const before = await metrics(client);
      const digest = createHash("sha256");
      let inputBytes = 0;
      let bytes = 0;
      let frames = 0;
      const start = performance.now();
      if (mode === "upload") {
        const size = 32 * 1024 * 1024;
        inputBytes = size;
        const upload = Upload.parse(
          await client.request({ op: "upload.begin", path: "uploaded", expected: null, size }),
        );
        const chunk = Buffer.alloc(CHUNK_SIZE, 127);
        while (bytes < size) {
          client.socket.send(encodeFileFrame(upload.channel, bytes, chunk));
          const ack = Upload.parse(await client.next());
          bytes += chunk.length;
          frames++;
          digest.update(chunk);
          if (ack.offset !== bytes) throw new Error("Wrong upload offset");
        }
        const commit = await client.request({
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest.digest("hex"),
        });
        if (commit.type !== "files.result") throw new Error("Upload failed");
      } else {
        let operation;
        if (mode === "archive") {
          const preview = z
            .object({ value: z.object({ previewId: z.string(), bytes: z.number() }) })
            .parse(
              await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
            );
          operation = { op: "archive.download" as const, previewId: preview.value.previewId };
          inputBytes = preview.value.bytes;
        } else {
          operation = {
            op: "download" as const,
            path: mode === "slow" ? "slow" : "binary",
            offset: 0,
          };
          inputBytes = (mode === "slow" ? 32 : 200) * 1024 ** 2;
        }
        const ready = Ready.parse(await client.request(operation));
        for (;;) {
          // One 64 KiB credit each 31.25 ms simulates a 2 MiB/s receiving link.
          if (mode === "slow") await delay((CHUNK_SIZE / (2 * 1024 * 1024)) * 1000);
          client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
          const next = await client.next();
          if (!Buffer.isBuffer(next)) {
            if (next.type !== "files.end" || next.sha256 !== digest.digest("hex"))
              throw new Error("Transfer failed");
            break;
          }
          const frame = decodeFileFrame(next);
          if (frame.offset !== bytes) throw new Error("Wrong download offset");
          digest.update(frame.bytes);
          bytes += frame.bytes.length;
          frames++;
          if (ready.size !== null && bytes === ready.size) {
            const end = await client.next();
            if (
              Buffer.isBuffer(end) ||
              end.type !== "files.end" ||
              end.sha256 !== digest.digest("hex")
            )
              throw new Error("Transfer failed");
            break;
          }
        }
      }
      const elapsed = performance.now() - start;
      const memory = await metrics(client);
      console.log(
        JSON.stringify({
          mode,
          MiB: bytes / 1024 ** 2,
          inputMiB: inputBytes / 1024 ** 2,
          inputMiBPerSecond: inputBytes / 1024 ** 2 / (elapsed / 1000),
          seconds: elapsed / 1000,
          MiBPerSecond: bytes / 1024 ** 2 / (elapsed / 1000),
          framesPerSecond: frames / (elapsed / 1000),
          peakRssMiB: memory.peak / 1024 ** 2,
          rssGrowthMiB: (memory.rss - before.rss) / 1024 ** 2,
        }),
      );
    } finally {
      await server.close();
    }
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
