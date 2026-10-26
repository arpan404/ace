import { findExecutable } from "@ace/provider-kit/discovery";
import type { DeviceRuntime } from "./runtime.ts";

/** What a version probe needs from the runtime. */
type ProbeRuntime = Pick<DeviceRuntime, "spawn" | "after">;

/**
 * serve-sim drives private CoreSimulator interfaces that change between Xcode releases, and its
 * HTTP and WebSocket routes are not a stable API. ace runs only the versions it was checked
 * against; any other version leaves iOS on the screen helper (ADR 0064). 0.1.48 left an iPhone
 * Duo's stream black after some hours on Xcode 27, so only the newer build is accepted.
 */
export const pinnedServeSim = "0.1.49-beta.139.1";
export const serveSimVersions: readonly string[] = [pinnedServeSim];

export function serveSimSupported(version: string | undefined): boolean {
  return version !== undefined && serveSimVersions.includes(version);
}

/** The version a serve-sim executable reports, or undefined when it doesn't answer sanely. */
export async function serveSimVersion(
  run: { command: string; args: readonly string[] },
  runtime: ProbeRuntime,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const child = runtime.spawn({
    command: run.command,
    args: [...run.args, "--version"],
    env,
    name: "serve-sim-version",
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (output.length < 256) output += chunk.toString("utf8");
  });
  child.stderr.resume();
  const cancel = runtime.after(10000, () => {
    void child.stop({ graceMs: 0 }).catch(() => {});
  });
  try {
    const exit = await child.exited;
    if (exit.code !== 0) return undefined;
    return /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/.exec(output)?.[1];
  } finally {
    cancel();
    await child.stop({ graceMs: 0 }).catch(() => {});
  }
}

/**
 * The serve-sim this machine would use: how to run it (`args` go before serve-sim's own), its
 * version, whether ace runs it, and whose copy it is.
 */
export interface ServeSimStatus {
  command?: string;
  args: string[];
  version?: string;
  supported: boolean;
  /** `env`: ACE_SERVE_SIM; `ace`: the copy ace downloaded; `path`: one on PATH. */
  source?: "env" | "ace" | "path";
}

/**
 * Find serve-sim and read its version: `ACE_SERVE_SIM` when set, else ace's own copy
 * (`managed`, from the device tools download), else one on PATH.
 */
export async function serveSimStatus(
  env: NodeJS.ProcessEnv,
  runtime: ProbeRuntime,
  managed?: { command: string; args: string[] },
): Promise<ServeSimStatus> {
  const explicit = env["ACE_SERVE_SIM"];
  const found = explicit
    ? await findExecutable(explicit, env).then((command) => command && { command, args: [] })
    : managed;
  const source = explicit ? "env" : managed ? "ace" : "path";
  const run =
    found ??
    (explicit
      ? undefined
      : await findExecutable("serve-sim", env).then((command) => command && { command, args: [] }));
  if (!run) return { args: [], supported: false };
  const version = await serveSimVersion(run, runtime, env);
  return {
    command: run.command,
    args: run.args,
    ...(version !== undefined ? { version } : {}),
    supported: serveSimSupported(version),
    source: found ? source : "path",
  };
}
