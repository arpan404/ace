import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { NativeAccountProvider } from "@ace/protocol/accounts";
import { openRegistry } from "./registry.ts";
import { createInstance, discoverHomes, loginStatus } from "./instances.ts";
import { addAccount } from "./login.ts";
import { discoverCursorSdk } from "@ace/adapter-cursor";
import { cursorSdkLoginDriver } from "./cursor-sdk.ts";

export async function runAccountsCommand(args: readonly string[]) {
  const [namespace, command, ...rest] = args;
  const path =
    process.env["ACE_ACCOUNTS_DB"] ??
    join(process.env["ACE_HOME"] ?? join(homedir(), ".ace"), "accounts.sqlite");
  if (namespace !== "accounts" || !["add", "list", "status", "discover"].includes(command ?? ""))
    throw new Error(
      "Usage: ace accounts add <provider> <id> <homeDir> <label> [--console] | list | status <id> | discover",
    );
  const registry = await openRegistry(path);
  try {
    if (command === "add") {
      const parsed = z
        .tuple([NativeAccountProvider, z.string(), z.string(), z.string()])
        .parse(rest.slice(0, 4));
      if (rest.length > 5 || (rest[4] !== undefined && rest[4] !== "--console"))
        throw new Error("Unknown login option");
      const [provider, id, homeDir, label] = parsed;
      const sdk = provider === "cursor" ? await discoverCursorSdk() : undefined;
      if (sdk?.installed && !sdk.supported) throw new Error(sdk.error ?? "Unsupported Cursor SDK");
      if (sdk?.installed && rest[4] === "--console")
        throw new Error(
          "Cursor SDK API authentication uses the existing launch environment; key entry is unavailable",
        );
      const cursorSdk = sdk?.installed
        ? cursorSdkLoginDriver(registry, {
            now: Date.now,
            launchEnv: process.env,
            stopInstance: async () => {
              throw new Error("SDK sign-out must use the daemon's selected-instance host owner");
            },
          })
        : undefined;
      const result = await addAccount(registry, createInstance({ provider, id, homeDir, label }), {
        now: Date.now,
        mode: rest[4] === "--console" ? "api" : "subscription",
        ...(cursorSdk
          ? {
              cursorSdk,
              loginUrl: (url: string) => process.stdout.write(`Cursor SDK sign-in: ${url}\n`),
            }
          : {}),
      });
      if (result.code !== 0) process.exitCode = 1;
    } else if (command === "status") {
      if (rest.length !== 1) throw new Error("Expected instance ID");
      const account = registry.get(rest[0] ?? "");
      if (!account) throw new Error("Unknown instance");
      const sdk = account.instance.provider === "cursor" ? await discoverCursorSdk() : undefined;
      if (sdk?.installed && !sdk.supported) throw new Error(sdk.error ?? "Unsupported Cursor SDK");
      const sdkStatus = sdk?.installed
        ? await cursorSdkLoginDriver(registry, {
            now: Date.now,
            launchEnv: process.env,
            stopInstance: async () => {
              throw new Error("Status worker cannot sign out live sessions");
            },
          }).status(account.instance, new AbortController().signal)
        : undefined;
      const status = sdkStatus
        ? { auth: sdkStatus.status === "logged-in" ? "logged_in" : "logged_out" }
        : await loginStatus(account.instance);
      registry.ingest(account.instance.id, {
        provider: account.instance.provider,
        payload: new ProviderPayload(JSON.stringify({ auth: status.auth })),
        observedAt: Date.now(),
        timeZone: "UTC",
      });
      process.stdout.write(
        `${JSON.stringify(registry.summaries(Date.now()).find((a) => a.id === account.instance.id))}\n`,
      );
    } else if (command === "discover") {
      for (const instance of await discoverHomes(homedir()))
        process.stdout.write(`${JSON.stringify(instance)}\n`);
    } else process.stdout.write(`${JSON.stringify(registry.summaries(Date.now()))}\n`);
  } finally {
    registry.close();
  }
}
