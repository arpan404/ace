import { detectToolchains, toolchainProbe } from "@ace/diagnostics/toolchains";
import { createProbeThread, type ProbeThread } from "@ace/provider-kit/process";
import type { Toolchain } from "@ace/protocol";
import { bundledWorkerUrl } from "../bundled-worker.ts";

/** The probe thread's bundle, written beside the main bundle (`scripts/common.ts`). */
export const PROBE_WORKER_BUNDLE = "probe-worker.mjs";

/**
 * Toolchain detection for the main process, given the main bundle's URL. Its probes run on the
 * bundled probe worker: the package's own entry (`probe-worker.ts`) is source the app does not
 * ship, so without it every probe fails and every tool reads as missing.
 */
export function bundledToolchains(
  mainUrl: string,
): (env: NodeJS.ProcessEnv) => Promise<Toolchain[]> {
  let thread: ProbeThread | undefined;
  return (env) => {
    thread ??= createProbeThread(bundledWorkerUrl(mainUrl, PROBE_WORKER_BUNDLE));
    return detectToolchains(env, process.platform, toolchainProbe(env, thread));
  };
}
