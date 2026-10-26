import { z } from "zod";
import type { DeviceRuntime } from "./runtime.ts";

type HelperRuntime = Pick<DeviceRuntime, "spawn" | "after">;

/** What `serve-sim -l <udid>` prints while a helper streams that simulator. */
const Listed = z.object({
  running: z.literal(true),
  device: z.string().max(64),
  pid: z.number().int().positive(),
});

/**
 * Whether a helper started by `commandLine` should give way to serve-sim `version`: it runs a
 * copy ace downloaded (`…/serve-sim-<version>/dist/serve-sim.js`) of another version. Helpers
 * from any other serve-sim belong to the person and are always kept.
 */
export function replacesHelper(commandLine: string, version: string): boolean {
  const managed =
    /\/serve-sim-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\/dist\/serve-sim\.js(?:\s|$)/.exec(
      commandLine,
    )?.[1];
  return managed !== undefined && managed !== version;
}

/**
 * Runs a short command and returns what it printed: everything when it exits, or only the
 * first line when `firstLine` is set (a CLI that keeps running is stopped once it answers).
 */
async function output(
  runtime: HelperRuntime,
  env: NodeJS.ProcessEnv,
  run: { command: string; args: readonly string[]; timeoutMs: number; firstLine?: boolean },
): Promise<string> {
  const child = runtime.spawn({
    command: run.command,
    args: run.args,
    env,
    name: "serve-sim-helper-check",
  });
  child.stdin.end();
  child.stderr.resume();
  let text = "";
  const line = Promise.withResolvers<void>();
  child.stdout.on("data", (chunk: Buffer) => {
    if (text.length < 16384) text += chunk.toString("utf8");
    if (run.firstLine && text.includes("\n")) line.resolve();
  });
  const cancel = runtime.after(run.timeoutMs, () => line.resolve());
  try {
    await Promise.race([child.exited, line.promise]);
    return run.firstLine ? (text.split("\n")[0] ?? "") : text;
  } finally {
    cancel();
    await child.stop({ graceMs: 0 }).catch(() => {});
  }
}

/**
 * serve-sim reuses whatever helper already streams a simulator, whichever version started it,
 * and a helper outlives ace's stream. So after ace moves to a new serve-sim, a helper its older
 * copy left running is stopped here and the next stream starts a fresh one. Best effort: when
 * anything can't be read, the running helper is left alone.
 */
export async function replaceOutdatedHelper(options: {
  command: string;
  args: readonly string[];
  version: string;
  udid: string;
  env: NodeJS.ProcessEnv;
  runtime: HelperRuntime;
}): Promise<void> {
  const { runtime, env } = options;
  const serveSim = (args: string[], timeoutMs: number, firstLine?: boolean) =>
    output(runtime, env, {
      command: options.command,
      args: [...options.args, ...args],
      timeoutMs,
      ...(firstLine ? { firstLine } : {}),
    });
  try {
    const listed = Listed.safeParse(JSON.parse(await serveSim(["-l", options.udid], 5000, true)));
    if (!listed.success || listed.data.device.toLowerCase() !== options.udid.toLowerCase()) return;
    const commandLine = await output(runtime, env, {
      command: "/bin/ps",
      args: ["-o", "command=", "-p", String(listed.data.pid)],
      timeoutMs: 5000,
    });
    if (!replacesHelper(commandLine.trim(), options.version)) return;
    await serveSim(["-k", options.udid], 10000);
  } catch {
    // Unreadable answers leave the running helper as it is.
  }
}
