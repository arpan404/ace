import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CliOperation, ThreadId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { print, result } from "./io.ts";
import { CliFailure, exitCodes, type Outcome } from "./output.ts";
import { simCall } from "./sim-args.ts";
import { simHuman } from "./sim-human.ts";

const Shot = z.looseObject({
  simId: z.string(),
  sequence: z.number(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
  note: z.string(),
  base64: z.string(),
});
const Failure = z.looseObject({
  code: z.string(),
  message: z.string().optional(),
  hint: z.string().optional(),
  detail: z.string().optional(),
});
/** A person holding the device is something to wait out, not a failure of the call. */
function outcome(code: string): Outcome {
  if (code === "lease_required") return "needs-human";
  if (code === "timeout") return "timeout";
  if (code === "invalid_arguments") return "refused";
  return "failed";
}

/** `ace sim`: one sim_* tool call for the thread's agent, JSON out by default. */
export async function simCommand(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(
    args,
    [
      "thread",
      "human",
      "no-boot",
      "out",
      "limit",
      "name",
      "text",
      "role",
      "max-depth",
      "max-nodes",
      "value",
      "duration",
    ],
    2,
    8,
  );
  const thread = option(args, "thread");
  if (!thread)
    throw new CliFailure(
      "refused",
      "ace sim needs --thread THREAD_ID: your own thread. See ace sim --help.",
    );
  const call = simCall(args);
  const operation = CliOperation.parse({
    op: "sim",
    threadId: ThreadId.parse(thread),
    verb: call.verb,
    args: call.args,
  });
  const response = await client.request({ type: "cli.request", operation }, { signal });
  const human = args.flags.human === true;
  // JSON is the default here: one compact line per call, for agents to read.
  const json: Args = { ...args, flags: { ...args.flags, json: true } };
  if (!response.result.ok) {
    const failure = Failure.safeParse(response.result.data);
    const body = failure.success
      ? failure.data
      : { code: response.result.code ?? "unavailable", hint: response.result.hint };
    const status = outcome(body.code);
    if (human) {
      process.stderr.write(
        `${[body.code, failure.success ? failure.data.message : undefined, failure.success ? failure.data.detail : undefined].filter(Boolean).join(": ")}\n${body.hint ?? ""}\n`,
      );
      process.exitCode = exitCodes[status];
      return;
    }
    return result(json, { ok: false, ...body }, status);
  }
  let data = response.result.data;
  if (call.verb === "screenshot") {
    const shot = Shot.parse(data);
    const safe = shot.simId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const out = option(args, "out");
    const path = out
      ? resolve(out)
      : join(tmpdir(), `ace-sim-${safe}-${process.pid}-${shot.sequence}.jpg`);
    await writeFile(path, Buffer.from(shot.base64, "base64"), { mode: 0o600 });
    const { base64: _bytes, ...rest } = shot;
    data = { ...rest, path, mimeType: "image/jpeg" };
  }
  if (human) return print(args, simHuman(call.verb, data));
  return result(json, data);
}
