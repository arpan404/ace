import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CliOperation, ThreadId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, type Args } from "./args.ts";
import { outputMode } from "./input-mode.ts";
import { emit, result } from "./io.ts";
import { exitCodes, usageFailure, type Outcome } from "./output.ts";
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

/**
 * `ace sim`: one sim_* tool call for the thread's agent. Short text by default, one compact
 * JSON line with --json (ADR 0178 §8). `thread` is --thread or ACE_THREAD_ID.
 */
export async function simCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  thread: string | undefined,
) {
  if (!thread)
    throw usageFailure("ace sim needs your thread: pass --thread THREAD.", {
      code: "missing_argument",
      argument: "--thread",
      hint: "In an agent's shell ace sets ACE_THREAD_ID; see ace sim --help.",
    });
  const call = simCall(args);
  const operation = CliOperation.parse({
    op: "sim",
    threadId: ThreadId.parse(thread),
    verb: call.verb,
    args: call.args,
  });
  const response = await client.request({ type: "cli.request", operation }, { signal });
  const json = outputMode(args.flags) === "json";
  if (!response.result.ok) {
    const failure = Failure.safeParse(response.result.data);
    const body = failure.success
      ? failure.data
      : { code: response.result.code ?? "unavailable", hint: response.result.hint };
    const status = outcome(body.code);
    if (!json) {
      process.stderr.write(
        `${[body.code, failure.success ? failure.data.message : undefined, failure.success ? failure.data.detail : undefined].filter(Boolean).join(": ")}\n${body.hint ?? ""}\n`,
      );
      process.exitCode = exitCodes[status];
      return;
    }
    return result(args, { ok: false, ...body }, status);
  }
  let data = response.result.data;
  if (call.verb === "screenshot") {
    const shot = Shot.parse(data);
    const safe = shot.simId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const out = option(args, "output") ?? option(args, "out");
    const path = out
      ? resolve(out)
      : join(tmpdir(), `ace-sim-${safe}-${process.pid}-${shot.sequence}.jpg`);
    await writeFile(path, Buffer.from(shot.base64, "base64"), { mode: 0o600 });
    const { base64: _bytes, ...rest } = shot;
    data = { ...rest, path, mimeType: "image/jpeg" };
  }
  if (!json) return emit(args, data, { human: (value) => simHuman(call.verb, value) });
  return result(args, data);
}
