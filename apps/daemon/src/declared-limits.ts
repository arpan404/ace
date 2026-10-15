import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { AccountRegistry } from "@ace/accounts";
import {
  instanceEnv,
  readDeclaredUsage,
  type UsageDeclaration,
  type UsagePorts,
} from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderInstance } from "@ace/protocol/accounts";

/*
 * Every account whose provider or ACP agent declares a usage source gets its limits read here,
 * on the same cadence as Codex's. One account failing never stops the others, and a failure
 * only ever reports fixed words: the reader never hands back a credential.
 */

/** The real I/O behind a usage read: the CLI's own files, HTTPS and its own executable. */
export const defaultUsagePorts = (now: () => number): UsagePorts => ({
  readFile: (path) => readFile(path, "utf8"),
  fetch: (url, init) => fetch(url, init),
  run: ({ executable, args, env, cwd, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { env, cwd, timeout: timeoutMs, signal, maxBuffer: 256 * 1024, windowsHide: true },
        (error, stdout) => (error ? reject(new Error("Usage command failed")) : resolve(stdout)),
      );
    }),
  now,
});

export async function refreshDeclaredLimits(options: {
  registry: AccountRegistry;
  declaration(instance: ProviderInstance): UsageDeclaration | undefined;
  /** The account's own CLI, for command sources; undefined when it isn't installed. */
  executable(instance: ProviderInstance): string | undefined;
  env: NodeJS.ProcessEnv;
  ports: UsagePorts;
  now(): number;
  signal: AbortSignal;
  enabled?(instance: ProviderInstance): boolean;
  onError?(instance: string, message: string): void;
}): Promise<void> {
  const accounts = options.registry
    .list()
    .filter(
      ({ instance, quota }) =>
        quota.auth !== "logged_out" &&
        !quota.blockers.homeUnavailable &&
        options.enabled?.(instance) !== false &&
        options.declaration(instance) !== undefined,
    );
  await Promise.all(
    accounts.map(async ({ instance }) => {
      const declaration = options.declaration(instance);
      if (!declaration) return;
      try {
        const result = await readDeclaredUsage(
          declaration,
          {
            homeDir: instance.homeDir,
            env: instanceEnv(instance, options.env),
            executable: options.executable(instance) ?? "",
          },
          options.ports,
          options.signal,
        );
        if (!result.ok) {
          options.onError?.(instance.id, result.message);
          return;
        }
        options.registry.ingest(instance.id, {
          provider: instance.provider,
          payload: new ProviderPayload(JSON.stringify(result.reading)),
          observedAt: options.now(),
          timeZone: "UTC",
        });
      } catch {
        options.onError?.(instance.id, `${declaration.cli} usage is unavailable`);
      }
    }),
  );
}
