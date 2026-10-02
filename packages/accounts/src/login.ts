import { spawn } from "node:child_process";
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
  },
) {
  const args = loginArgs(instance.provider, options.mode);
  registry.register(instance);
  await mkdir(instance.homeDir, { recursive: true, mode: 0o700 });
  const status = await loginStatus(instance, options.discovery);
  if (!status.path) throw new Error("Provider CLI is not installed");
  if (
    instance.provider === "cursor" &&
    status.error === "Cursor account isolation is not verified for this CLI version"
  )
    throw new Error(status.error);
  const env = instanceEnv(instance, options.discovery?.env ?? process.env);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(status.path ?? "", args, {
      env,
      stdio: "inherit",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const after = await loginStatus(instance, options.discovery);
  registry.ingest(instance.id, {
    provider: instance.provider,
    payload: { auth: after.auth },
    observedAt: options.now(),
    timeZone: "UTC",
  });
  return { code, status: after };
}
