import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { openFileSink } from "./file-sink.ts";
const config = z
  .object({
    directory: z.string(),
    fileBytes: z.number().optional(),
    totalBytes: z.number(),
    context: z.object({
      home: z.string().optional(),
      workspace: z.string().optional(),
      env: z.record(z.string(), z.string().optional()).optional(),
    }),
  })
  .parse(workerData);
const record = z.object({
  at: z.number(),
  level: z.enum(["debug", "info", "warn", "error"]),
  component: z.string(),
  message: z.string(),
  data: z.unknown(),
});
const sink = await openFileSink({
  directory: config.directory,
  totalBytes: config.totalBytes,
  ...(config.fileBytes === undefined ? {} : { fileBytes: config.fileBytes }),
});
const redact = createDiagnosticRedactor(config.context);
const port = parentPort;
if (!port) throw new Error("Logger requires a parent");
const request = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), records: z.array(record).max(65536) }),
  z.object({ type: z.literal("resize"), totalBytes: z.number() }),
]);
port.on("message", async (input: unknown) => {
  try {
    const message = request.parse(input);
    if (message.type === "resize") await sink.resize(message.totalBytes);
    else await sink.write(message.records.map((entry) => redact(JSON.stringify(entry)) + "\n"));
    port.postMessage({ ok: true });
  } catch {
    port.postMessage({ ok: false });
  }
});
port.postMessage({ ready: true });
