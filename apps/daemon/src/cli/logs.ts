import { join } from "node:path";
import { CliLogRecord } from "@ace/protocol/cli-outputs";
import { spawnSupervised } from "@ace/provider-kit/process";
import { option, type Args } from "./args.ts";
import { emit, print } from "./io.ts";
import { outputMode } from "./input-mode.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { logLine } from "./render/daemon.ts";

/** `--limit`: 1 to 1000 lines, 100 by default. */
export function logLimit(args: Args): number {
  const raw = option(args, "limit");
  if (raw === undefined) return 100;
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isInteger(limit) && limit >= 1 && limit <= 1000) return limit;
  throw usageFailure("--limit takes a whole number from 1 to 1000.", { argument: "--limit" });
}

/**
 * `ace logs [--follow]` (`ace daemon logs`): the daemon's log, `logs/ace.jsonl`. A person reads
 * one line per record; `--json` prints the records as one list, or with `--follow` one JSON
 * line each as they come. Native `tail` owns file replacement and partial UTF-8; ace only
 * checks and formats records.
 */
export async function logsCommand(args: Args, home: string, color: boolean) {
  const follow = !!args.flags.f || !!args.flags.follow;
  const limit = logLimit(args);
  const mode = outputMode(args.flags);
  const child = spawnSupervised({
    command: "tail",
    args: ["-n", String(limit), ...(follow ? ["-F"] : []), join(home, "logs", "ace.jsonl")],
    env: process.env,
    name: "ace-log-reader",
    maxLineBytes: 1_048_576,
  });
  const records: CliLogRecord[] = [];
  let writes = Promise.resolve();
  let queued = 0;
  let failure: unknown;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    // The exit awaited below carries the outcome; stopping now is only a head start.
    void child.stop({ graceMs: 100 }).catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const show = (record: CliLogRecord) =>
    mode === "json"
      ? print({ ...args, flags: { ...args.flags, stream: "jsonl" } }, { type: "log", record })
      : mode === "human"
        ? emit(args, record, { human: (value) => logLine(value, color) })
        : Promise.resolve();
  child.stdout.on("line", (line) => {
    try {
      const record = CliLogRecord.parse(JSON.parse(line));
      if (!follow) {
        records.push(record);
        if (records.length > limit)
          throw new CliFailure("uncertain", "The log had more lines than were asked for.");
        return;
      }
      queued += Buffer.byteLength(line);
      if (queued > 1_048_576)
        throw new CliFailure("uncertain", "The log came faster than it could be printed.");
      writes = writes
        .then(() => show(record))
        .catch((error: unknown) => {
          failure = error;
          // The exit awaited below carries the outcome; stopping now is only a head start.
          void child.stop({ graceMs: 100 }).catch(() => {});
        })
        .finally(() => {
          queued -= Buffer.byteLength(line);
        });
    } catch (error) {
      failure = error;
      // The exit awaited below carries the outcome; stopping now is only a head start.
      void child.stop({ graceMs: 100 }).catch(() => {});
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
      throw new CliFailure(
        "failed",
        /No such file/i.test(diagnostic)
          ? "ace has no log yet on this machine."
          : diagnostic || "The log couldn't be read.",
        undefined,
        { code: "failed", hint: "ace writes it once the daemon has run: ace start." },
      );
    if (!follow)
      await emit(args, records, {
        human: (all) => all.map((record) => logLine(record, color)),
        quiet: () => [],
      });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await child.stop({ graceMs: 100 });
  }
}
