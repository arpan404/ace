import { spawnInteractive } from "@ace/provider-kit/process";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { mkdir } from "node:fs/promises";
import { loginStatus, instanceEnv, loginArgs } from "./instances.ts";
import type { ProviderInstance } from "@ace/protocol/accounts";
import type { AccountRegistry } from "./registry.ts";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";

/** The CLI owns credential entry and browser login; ace inherits terminal streams. */
export async function addAccount(
  registry: AccountRegistry,
  instance: ProviderInstance,
  options: {
    now: () => number;
    discovery?: DiscoveryOptions;
    mode?: "subscription" | "api";
    signal?: AbortSignal;
    spawn?: typeof spawnInteractive;
    cancellationGraceMs?: number;
  },
) {
  if (instance.provider === "acp")
    throw new Error("Use the reviewed ACP local-login API; account isolation is unsupported");
  const args = loginArgs(instance.provider, options.mode);
  options.signal?.throwIfAborted();
  await registry.register(instance);
  await mkdir(instance.homeDir, { recursive: true, mode: 0o700 });
  const status = await loginStatus(instance, options.discovery);
  if (!status.path) throw new Error("Provider CLI is not installed");
  if (
    instance.provider === "cursor" &&
    status.error === "Cursor account isolation is not verified for this CLI version"
  )
    throw new Error(status.error);
  const env = instanceEnv(instance, options.discovery?.env ?? process.env);
  options.signal?.throwIfAborted();
  const child = (options.spawn ?? spawnInteractive)({ command: status.path, args, env });
  const cancel = () => {
    void child.stop({ graceMs: options.cancellationGraceMs ?? 500 });
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let code: number | null;
  try {
    const exit = await child.exited;
    options.signal?.throwIfAborted();
    if (exit.reason === "spawn-error") throw new Error("Login CLI failed to start");
    code = exit.code;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
  const after = await loginStatus(instance, options.discovery);
  registry.ingest(instance.id, {
    provider: instance.provider,
    payload: new ProviderPayload(JSON.stringify({ auth: after.auth })),
    observedAt: options.now(),
    timeZone: "UTC",
  });
  return { code, status: after };
}
