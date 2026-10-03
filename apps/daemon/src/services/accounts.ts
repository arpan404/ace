import { warmup } from "./warmup.ts";
import { AccountService, openRegistryIndex } from "@ace/accounts";
import { join } from "node:path";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startAccounts(context: ServiceContext) {
  const { config, resources, services, now, options } = context;
  const registry = await openRegistryIndex(
    process.env.ACE_ACCOUNTS_DB ?? join(config.dataDir, "accounts.sqlite"),
    context.signal,
  );
  const validation = warmup(context, "accounts", () => registry.ready);
  resources.own(async () => {
    await validation;
    registry.close();
  });
  services.accountRegistry = registry;
  services.accounts = new AccountService({
    registry,
    now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    env: process.env,
    cursorEnv: options.engine?.cursor?.env ?? process.env,
    resolveAcpLogin: (identity, env) =>
      services.agentRegistry?.resolveLogin(identity, env) ?? Promise.resolve(undefined),
  });
}
export function createAccountsSession(context: SocketContext): SocketService {
  let pending = 0;
  return {
    handle(message) {
      if (
        message.type !== "accounts.list" &&
        message.type !== "accounts.status" &&
        message.type !== "accounts.migrate"
      )
        return false;
      const reject = (code: string, detail: string) =>
        context.fail(code, detail, false, { requestId: message.requestId });
      const scope = message.type === "accounts.migrate" ? "operate" : "read";
      if (!context.authorize(scope)) reject("forbidden", `${scope} scope required`);
      else if (!context.options.accounts)
        reject("accounts_unavailable", "Accounts service is unavailable");
      else if (pending >= 8) reject("accounts_busy", "Too many account requests");
      else {
        pending++;
        const task = context.options.accounts
          .handle(message)
          .then((result) => {
            if (context.connected() && context.authorize(scope)) context.send(result);
          })
          .catch(() =>
            reject("accounts_failed", "Account request failed validation or safety checks"),
          )
          .finally(() => {
            pending--;
            context.tasks.delete(task);
          });
        context.tasks.add(task);
      }
      return true;
    },
  };
}
