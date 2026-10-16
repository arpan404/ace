import {
  spawnRawSupervised,
  type SpawnOptions,
  type RawSupervisedProcess,
} from "@ace/provider-kit/process";
import type { ProviderKind } from "@ace/protocol";
import type { ProviderLoginDriver } from "@ace/accounts";

export function apiKeySupport(provider: ProviderKind, version?: string, help = "") {
  if (
    provider === "codex" &&
    /^(?:0|1)\.\d+\.\d+$/.test(version ?? "") &&
    help.includes("--with-api-key")
  )
    return { supported: true };
  if (provider === "cursor" && version === "1.0.35") return { supported: true };
  return {
    supported: false,
    reason:
      provider === "opencode"
        ? "OpenCode v2 accepts keys in its own sign-in terminal. Choose Sign in to open it in ace."
        : provider === "claude"
          ? "Claude supports browser login or an environment key/helper, but no reviewed stdin key-storage command."
          : provider === "pi"
            ? "Pi exposes keys through argv, environment or a user-managed auth file, not a stdin key-storage command."
            : "The installed runtime has no reviewed stdin API-key credential path.",
  };
}

/** Owns only a bounded in-memory key. Output is drained and discarded, never parsed after submission. */
export function apiKeyLoginDriver(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn?: (options: SpawnOptions) => RawSupervisedProcess;
  assertCurrent?(): void;
}): ProviderLoginDriver {
  let accept: ((key: Buffer) => void) | undefined;
  let child: RawSupervisedProcess | undefined;
  return {
    apiKey(key) {
      if (!accept) return false;
      const consume = accept;
      accept = undefined;
      consume(key);
      return true;
    },
    async drain() {
      if (child) await child.stop();
    },
    async run(signal, emit) {
      const key = await new Promise<Buffer>((resolve, reject) => {
        const abort = () => {
          accept = undefined;
          reject(new Error("Cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        accept = (submitted) => {
          signal.removeEventListener("abort", abort);
          resolve(submitted);
        };
        emit({ state: "awaiting_api_key", prompt: "Enter the API key for this account." });
        if (signal.aborted) abort();
      });
      try {
        signal.throwIfAborted();
        options.assertCurrent?.();
        child = (options.spawn ?? spawnRawSupervised)({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          env: options.env,
          name: "provider API-key login",
          maxOutputBytes: 262144,
        });
        const owned = child;
        const abort = () => {
          void owned.stop();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          owned.stderr.resume();
          owned.stdout.resume();
          signal.throwIfAborted();
          emit({ state: "verifying" });
          options.assertCurrent?.();
          await new Promise<void>((resolve, reject) => {
            owned.stdin.write(key, (error) =>
              error ? reject(new Error("Key hand-off failed")) : resolve(),
            );
          });
          key.fill(0);
          owned.stdin.end("\n");
          const exit = await owned.exited;
          signal.throwIfAborted();
          return { success: exit.code === 0 && exit.reason === "exit" };
        } finally {
          signal.removeEventListener("abort", abort);
          await owned.stop();
        }
      } finally {
        key.fill(0);
        accept = undefined;
      }
    },
  };
}
