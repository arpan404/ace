import { spawnInteractive } from "@ace/provider-kit/process";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { mkdir } from "node:fs/promises";
import { loginStatus, instanceEnv, loginArgs } from "./instances.ts";
import type { ProviderInstance } from "@ace/protocol/accounts";
import type { AccountRegistry } from "./registry.ts";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";
import type { cursorSdkLoginDriver } from "./cursor-sdk.ts";

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
    cursorSdk?: ReturnType<typeof cursorSdkLoginDriver>;
    loginUrl?: (url: string) => void;
  },
) {
  if (instance.provider === "cursor" && options.cursorSdk) {
    options.signal?.throwIfAborted();
    await registry.register(instance);
    const signal = options.signal ?? new AbortController().signal;
    const before = await options.cursorSdk.status(instance, signal);
    if (before.status !== "logged-in") {
      if (!options.loginUrl)
        throw new Error("Cursor SDK login requires an authorized ephemeral URL callback");
      await options.cursorSdk.login(instance, signal, options.loginUrl);
    }
    const after = await options.cursorSdk.status(instance, signal);
    return {
      code: after.status === "logged-in" ? 0 : 1,
      status: {
        installed: true,
        auth: after.status === "logged-in" ? ("logged_in" as const) : ("logged_out" as const),
        version: "1.0.35",
        loginHint: "Cursor SDK sign-in is separate from CLI/editor login",
      },
    };
  }
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
