import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
 * on the same cadence as Codex's. One account failing never stops the others. What is recorded
 * or reported is the reader's reading and fixed words: the reader never hands back a credential.
 */

const maxFileBytes = 256 * 1024;

/** The real I/O behind a usage read: the CLI's own files, HTTPS and its own executable. */
export const defaultUsagePorts = (now: () => number): UsagePorts => ({
  async readFile(path) {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxFileBytes) throw new Error("Not a credential file");
    return readFile(path, "utf8");
  },
  async readSqlite({ path, table, keyColumn, key, valueColumn }) {
    // Identifiers are schema-checked declaration data; only the key is a bound value.
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT "${valueColumn}" AS value FROM "${table}" WHERE "${keyColumn}" = ? LIMIT 1`,
        )
        .get(key);
      return typeof row?.["value"] === "string" ? row["value"] : undefined;
    } finally {
      db.close();
    }
  },
  fetch: (url, init) => fetch(url, init),
  run: ({ executable, args, env, cwd, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { env, cwd, timeout: timeoutMs, signal, maxBuffer: 256 * 1024, windowsHide: true },
        // stdout may hold a credential (a keychain read): it never reaches the error.
        (error, stdout) => (error ? reject(new Error("Usage command failed")) : resolve(stdout)),
      );
    }),
  platform: process.platform,
  now,
});

const providerKey = (instance: ProviderInstance) =>
  `${instance.provider}\0${instance.acpAgentId ?? ""}`;

export async function refreshDeclaredLimits(options: {
  registry: AccountRegistry;
  declaration(instance: ProviderInstance): UsageDeclaration | undefined;
  /** The account's own CLI, for command sources; undefined when it isn't installed. */
  executable(instance: ProviderInstance): string | undefined;
  env: NodeJS.ProcessEnv;
  /** The user's home, where a CLI keeps its own default login. */
  userHome: string;
  ports: UsagePorts;
  now(): number;
  signal: AbortSignal;
  enabled?(instance: ProviderInstance): boolean;
  onError?(instance: string, message: string): void;
}): Promise<void> {
  const all = options.registry.list();
  const accounts = all.filter(
    ({ instance, quota }) =>
      quota.auth !== "logged_out" &&
      !quota.blockers.homeUnavailable &&
      options.enabled?.(instance) !== false &&
      options.declaration(instance) !== undefined,
  );
  const perProvider = new Map<string, number>();
  for (const { instance } of all)
    perProvider.set(providerKey(instance), (perProvider.get(providerKey(instance)) ?? 0) + 1);
  await Promise.all(
    accounts.map(async ({ instance }) => {
      const declaration = options.declaration(instance);
      if (!declaration) return;
      const notice = (reason: "signed_out" | "unavailable", message: string) =>
        options.registry.recordUsageNotice(instance.id, {
          reason,
          message,
          observedAt: options.now(),
        });
      try {
        const result = await readDeclaredUsage(
          declaration,
          {
            homeDir: instance.homeDir,
            env: instanceEnv(instance, options.env),
            executable: options.executable(instance) ?? "",
            userHome: options.userHome,
            signedInAs: instance.signedInAs,
            soleAccount: perProvider.get(providerKey(instance)) === 1,
            baseEnv: options.env,
          },
          options.ports,
          options.signal,
        );
        if (!result.ok) {
          if (result.reason === "none") {
            options.registry.recordUsageNotice(instance.id, undefined);
            return;
          }
          notice(result.reason, result.message);
          options.onError?.(instance.id, result.message);
          return;
        }
        options.registry.ingest(instance.id, {
          provider: instance.provider,
          payload: new ProviderPayload(JSON.stringify(result.reading)),
          observedAt: options.now(),
          timeZone: "UTC",
        });
        if (result.notice) notice("signed_out", result.notice);
        else options.registry.recordUsageNotice(instance.id, undefined);
      } catch {
        options.onError?.(instance.id, `${declaration.cli} usage is unavailable`);
      }
    }),
  );
}
