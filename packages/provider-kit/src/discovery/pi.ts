import { findExecutable } from "./executable.ts";
import { probeOutput } from "../process.ts";
import type { DiscoveryResult } from "./types.ts";
import type { DiscoveryOptions } from "./index.ts";
/** Pi auth checks need an LLM provider. Generic discovery never selects one or starts a session. */
export async function discoverPi(
  options: Omit<DiscoveryOptions, "overrides"> & { executable?: string } = {},
): Promise<DiscoveryResult> {
  const env = { ...process.env, ...options.env };
  const path = await findExecutable(options.executable ?? "pi", env);
  const result: DiscoveryResult = {
    installed: !!path,
    auth: "unknown",
    loginHint: "pi, then /login on the local machine",
  };
  if (!path) return result;
  result.path = path;
  try {
    const output = await (options.probe ?? probeOutput)(path, ["--version"], {
      env,
      timeoutMs: options.timeoutMs ?? 4000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const match = /^(\d+\.\d+\.\d+)\s*$/.exec(output.stdout);
    if (output.code === 0 && match?.[1]) result.version = match[1];
    else result.error = "Unrecognized Pi version";
  } catch {
    result.error = "Pi version probe failed";
  }
  return result;
}
