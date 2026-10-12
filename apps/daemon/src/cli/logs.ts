import { z } from "zod";
import { join } from "node:path";
import { spawnSupervised } from "@ace/provider-kit/process";
import { option, validateArgs, type Args } from "./args.ts";
import { print, result } from "./io.ts";
import { CliFailure } from "./output.ts";
const Log = z
  .object({
    at: z.number(),
    level: z.enum(["debug", "info", "warn", "error"]),
    component: z.string(),
    message: z.string(),
    data: z.unknown(),
  })
  .passthrough();
/** Native tail owns file replacement and partial UTF-8; ace only validates/formats records. */
export async function logsCommand(args: Args, home: string) {
  validateArgs(args, ["f", "follow", "stream", "limit"], 1);
  const follow = !!args.flags.f || !!args.flags.follow;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(option(args, "limit") ?? 100);
  const child = spawnSupervised({
    command: "tail",
    args: ["-n", String(limit), ...(follow ? ["-F"] : []), join(home, "logs", "ace.jsonl")],
    env: process.env,
    name: "ace-log-reader",
    maxLineBytes: 1_048_576,
  });
  const records: z.infer<typeof Log>[] = [];
  let writes = Promise.resolve();
  let queued = 0;
  let failure: unknown;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void child.stop({ graceMs: 100 });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.stdout.on("line", (line) => {
    try {
      const entry = Log.parse(JSON.parse(line));
      if (!follow) {
        records.push(entry);
        if (records.length > limit)
          throw new CliFailure("uncertain", "Log output exceeds requested limit");
        return;
      }
      queued += Buffer.byteLength(line);
      if (queued > 1_048_576) throw new CliFailure("uncertain", "Log consumer is too slow");
      writes = writes
        .then(() =>
          print(
            { ...args, flags: { ...args.flags, stream: "jsonl" } },
            { type: "log", record: entry },
          ),
        )
        .catch((error: unknown) => {
          failure = error;
          void child.stop({ graceMs: 100 });
        })
        .finally(() => {
          queued -= Buffer.byteLength(line);
        });
    } catch (error) {
      failure = error;
      void child.stop({ graceMs: 100 });
    }
  });
  let diagnostic = "";
  child.stderr.on("line", (line) => {
    diagnostic = line.slice(-4096);
  });
  try {
    const exited = await child.exited;
    await writes;
    if (failure) throw failure;
    if (!interrupted && exited.code !== 0)
      throw new CliFailure("failed", diagnostic || "Log reader failed");
    if (!follow) await result(args, records);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await child.stop({ graceMs: 100 });
  }
}
