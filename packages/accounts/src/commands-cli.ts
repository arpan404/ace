import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { AccountProvider } from "@ace/protocol/accounts";
import { openRegistry } from "./registry.ts";
import { createInstance, discoverHomes, loginStatus } from "./instances.ts";
import { addAccount } from "./login.ts";

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
        .tuple([AccountProvider, z.string(), z.string(), z.string()])
        .parse(rest.slice(0, 4));
      if (rest.length > 5 || (rest[4] !== undefined && rest[4] !== "--console"))
        throw new Error("Unknown login option");
      const [provider, id, homeDir, label] = parsed;
      const result = await addAccount(registry, createInstance({ provider, id, homeDir, label }), {
        now: Date.now,
        mode: rest[4] === "--console" ? "api" : "subscription",
      });
      if (result.code !== 0) process.exitCode = 1;
    } else if (command === "status") {
      if (rest.length !== 1) throw new Error("Expected instance ID");
      const account = registry.get(rest[0] ?? "");
      if (!account) throw new Error("Unknown instance");
      const status = await loginStatus(account.instance);
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
