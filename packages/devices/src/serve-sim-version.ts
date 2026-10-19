import type { DeviceRuntime } from "./runtime.ts";

/**
 * serve-sim drives private CoreSimulator interfaces that change between Xcode releases, and its
 * HTTP and WebSocket routes are not a stable API. ace runs only the versions it was checked
 * against; any other version leaves iOS on the screen helper (ADR 0064).
 */
export const serveSimVersions: readonly string[] = ["0.1.47", "0.1.48"];
export const pinnedServeSim = "0.1.48";

export function serveSimSupported(version: string | undefined): boolean {
  return version !== undefined && serveSimVersions.includes(version);
}

/** The version a serve-sim executable reports, or undefined when it doesn't answer sanely. */
export async function serveSimVersion(
  command: string,
  runtime: DeviceRuntime,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const child = runtime.spawn({
    command,
    args: ["--version"],
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
    return /^\s*v?(\d+\.\d+\.\d+)\s*$/.exec(output)?.[1];
  } finally {
    cancel();
    await child.stop({ graceMs: 0 }).catch(() => {});
  }
}
