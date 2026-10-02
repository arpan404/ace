import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ContextService, deliverContext } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "ace-delivery-bench-"));
const service = await ContextService.open({
  root,
  now: Date.now,
  id: randomUUID,
  authorize: () => true,
  workspace: () => undefined,
});
try {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = await service.uploads.handle("device", {
    op: "upload.begin",
    threadId: "thread",
    bytes: bytes.length,
    sha256,
    name: "bench.png",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  await service.uploads.handle("device", {
    op: "upload.chunk",
    uploadId: begin.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  await service.uploads.handle("device", { op: "upload.commit", uploadId: begin.uploadId });
  const command = {
    id: "send",
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: "thread",
      input: [{ type: "text", text: "inspect" }],
      delivery: "queue",
      context: { mentions: [], attachments: Array.from({ length: 64 }, () => ({ sha256 })) },
    },
  };
  const start = performance.now();
  for (let i = 0; i < 1000; i++)
    await deliverContext(
      service,
      command,
      {
        provider: "codex",
        images: ["image/png"],
        documents: [],
        embeddedContext: false,
        maxInlineBytes: 0,
      },
      async (message) => {
        if (message.context.input.length !== 64) throw new Error("Missing provider context");
      },
    );
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify(
      {
        nativeDelivery64Us: (elapsed * 1000) / 1000,
        deliveriesPerSecond: 1000 / (elapsed / 1000),
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
