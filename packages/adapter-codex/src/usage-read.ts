import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";

/**
 * One account's Codex limits without a session: a short-lived `codex app-server` answers
 * `account/rateLimits/read` (every window, banked resets) and exits. It calls Codex's usage
 * endpoint only; no model turn runs and no quota is spent. The result is the read's own object,
 * for the account registry to decode like any other rate-limit report.
 */
export async function readCodexUsage(options: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
}): Promise<Record<string, unknown>> {
  options.signal.throwIfAborted();
  const proc = (options.spawn ?? spawnSupervised)({
    command: options.executable,
    args: ["app-server"],
    cwd: options.cwd,
    env: options.env,
    name: "codex-usage-read",
    maxOutputBytes: 1024 * 1024,
  });
  const abort = () => void proc.stop({ graceMs: 0 });
  options.signal.addEventListener("abort", abort, { once: true });
  const rpc = new JsonRpcPeer(proc, { timeoutMs: 20_000 });
  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "ace_usage", title: "ace usage", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
      { signal: options.signal },
    );
    rpc.notify("initialized");
    const result = await rpc.request("account/rateLimits/read", {}, { signal: options.signal });
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new Error("Codex returned no rate-limit snapshot");
    return { ...result };
  } finally {
    rpc.close();
    options.signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}
