import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { createRedactor } from "@ace/redaction";
import { openFileSink } from "./file-sink.ts";
const config = z
  .object({
    directory: z.string(),
    fileBytes: z.number(),
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
const sink = await openFileSink(config);
const redact = createRedactor(config.context);
const port = parentPort;
if (!port) throw new Error("Logger requires a parent");
port.on("message", async (input: unknown) => {
  try {
    const records = z.array(record).max(65536).parse(input);
    await sink.write(records.map((entry) => redact(JSON.stringify(entry)) + "\n"));
    port.postMessage({ ok: true });
  } catch {
    port.postMessage({ ok: false });
  }
});
port.postMessage({ ready: true });
