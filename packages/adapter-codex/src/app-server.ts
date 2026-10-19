import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";

export type AppServerOptions = {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  /** How long one request may wait for Codex. */
  timeoutMs?: number;
  /**
   * How long Codex may take to answer `initialize`. A real app-server answers at once; a CLI that
   * doesn't speak it is given up on quickly so callers fall back (sign-in to its terminal).
   */
  startupTimeoutMs?: number;
  /** `-c key=value` overrides for the app-server, after its subcommand. */
  args?: readonly string[];
};

/**
 * A short-lived `codex app-server`, initialized and ready for requests. Usage reads and account
 * sign-in use one; no model turn ever runs on it. Close it when done; aborting `signal` stops it.
 */
export async function openAppServer(
  options: AppServerOptions,
  name: string,
): Promise<{ rpc: JsonRpcPeer; close(): Promise<void> }> {
  options.signal.throwIfAborted();
  const proc = (options.spawn ?? spawnSupervised)({
    command: options.executable,
    args: ["app-server", ...(options.args ?? [])],
    cwd: options.cwd,
    env: options.env,
    name,
    maxOutputBytes: 1024 * 1024,
  });
  const abort = () => void proc.stop({ graceMs: 0 });
  options.signal.addEventListener("abort", abort, { once: true });
  const rpc = new JsonRpcPeer(proc, { timeoutMs: options.timeoutMs ?? 20_000 });
  const close = async () => {
    rpc.close();
    options.signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  };
  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "ace_usage", title: "ace usage", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
      { signal: options.signal, timeoutMs: options.startupTimeoutMs ?? 5_000 },
    );
    rpc.notify("initialized");
    return { rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}
