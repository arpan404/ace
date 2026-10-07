import { homedir } from "node:os";
import { resolveDaemonHome } from "@ace/service/home";
import { join } from "node:path";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { NativeAccountProvider } from "@ace/protocol/accounts";
import { openRegistry } from "./registry.ts";
import { createInstance, discoverHomes, loginStatus } from "./instances.ts";
import { addAccount } from "./login.ts";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import { daemonCursorAuth, cursorDaemonDriver, type CursorCliAuth } from "./cursor-cli-auth.ts";

export async function runAccountsCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    write?: (text: string) => void;
    sdkDiscovery?: typeof discoverCursorSdk;
    cursorAuth?: () => Promise<CursorCliAuth>;
  } = {},
) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const discovery = options.sdkDiscovery ?? discoverCursorSdk;
  let auth: CursorCliAuth | undefined;
  const driver = async () =>
    cursorDaemonDriver((auth ??= await (options.cursorAuth ?? (() => daemonCursorAuth(env)))()));
  const [namespace, command, ...rest] = args;
  const dataDir = resolveDaemonHome(env.HOME ?? homedir(), env.ACE_HOME);
  const path = env["ACE_ACCOUNTS_DB"] ?? join(dataDir, "accounts.sqlite");
  if (namespace !== "accounts" || !["add", "list", "status", "discover"].includes(command ?? ""))
    throw new Error(
      "Usage: ace accounts add <provider> <id> <homeDir> <label> [--console] | list | status <id> | discover",
    );
  const registry = await openRegistry(path, dataDir);
  try {
    if (command === "add") {
      const parsed = z
        .tuple([NativeAccountProvider, z.string(), z.string(), z.string()])
        .parse(rest.slice(0, 4));
      if (rest.length > 5 || (rest[4] !== undefined && rest[4] !== "--console"))
        throw new Error("Unknown login option");
      const [provider, id, homeDir, label] = parsed;
      const sdk = provider === "cursor" ? await discovery() : undefined;
      if (sdk && !sdk.installed) throw new Error("Cursor SDK is not installed");
      if (sdk?.installed && !sdk.supported) throw new Error(sdk.error ?? "Unsupported Cursor SDK");
      if (sdk?.installed && rest[4] === "--console")
        throw new Error(
          "Cursor SDK API authentication uses the existing launch environment; key entry is unavailable",
        );
      const cursorSdk = sdk?.installed ? await driver() : undefined;
      const result = await addAccount(registry, createInstance({ provider, id, homeDir, label }), {
        now,
        mode: rest[4] === "--console" ? "api" : "subscription",
        ...(cursorSdk
          ? {
              cursorSdk,
              loginUrl: (url: string) => write(`Cursor SDK sign-in: ${url}\n`),
            }
          : {}),
      });
      if (result.code !== 0) process.exitCode = 1;
    } else if (command === "status") {
      if (rest.length !== 1) throw new Error("Expected instance ID");
      const account = registry.get(rest[0] ?? "");
      if (!account) throw new Error("Unknown instance");
      await registry.validateHome(account.instance);
      const sdk = account.instance.provider === "cursor" ? await discovery() : undefined;
      if (sdk && !sdk.installed) throw new Error("Cursor SDK is not installed");
      if (sdk?.installed && !sdk.supported) throw new Error(sdk.error ?? "Unsupported Cursor SDK");
      const sdkStatus = sdk?.installed
        ? await (await driver()).status(account.instance, new AbortController().signal)
        : undefined;
      const status = sdkStatus
        ? { auth: sdkStatus.status === "logged-in" ? "logged_in" : "logged_out" }
        : await loginStatus(account.instance);
      registry.ingest(account.instance.id, {
        provider: account.instance.provider,
        payload: new ProviderPayload(JSON.stringify({ auth: status.auth })),
        observedAt: now(),
        timeZone: "UTC",
      });
      write(
        `${JSON.stringify(registry.summaries(now()).find((a) => a.id === account.instance.id))}\n`,
      );
    } else if (command === "discover") {
      for (const instance of await discoverHomes(env.HOME ?? homedir()))
        write(`${JSON.stringify(instance)}\n`);
    } else write(`${JSON.stringify(registry.summaries(now()))}\n`);
  } finally {
    try {
      await auth?.close();
    } finally {
      registry.close();
    }
  }
}
