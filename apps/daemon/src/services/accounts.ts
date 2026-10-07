import { cursorHosts } from "./cursor-hosts.ts";
import { warmup } from "./warmup.ts";
import { AccountManagementRequest } from "@ace/protocol/accounts";
import { AccountManagement } from "../account-management.ts";
import { AccountService, openRegistryIndex, cursorSdkLoginDriver } from "@ace/accounts";
import { join } from "node:path";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startAccounts(context: ServiceContext) {
  const { config, resources, services, now, options } = context;
  const registry = await openRegistryIndex(
    process.env.ACE_ACCOUNTS_DB ?? join(config.dataDir, "accounts.sqlite"),
    context.signal,
    config.dataDir,
    {
      notice: (event) =>
        context.log.log(
          event.outcome === "moved" ? "info" : "warn",
          "Account instance home migrated",
          { ...event },
        ),
    },
  );
  const validation = registry.ready;
  resources.own(async () => {
    try {
      await validation;
    } finally {
      registry.close();
    }
  });
  await validation;
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
export function startAccountManagement(context: ServiceContext): void {
  const { services, resources, config, now, id, options } = context;
  if (!services.accounts || !services.accountRegistry) return;
  const management = new AccountManagement({
    registry: services.accountRegistry,
    accounts: services.accounts,
    dataDir: config.dataDir,
    now,
    id,
    env: options.accounts?.env ?? process.env,
    signal: context.signal,
    discovery: options.accounts?.discovery,
    terminal: options.accounts?.terminal,
    models: () => services.models,
    cursor() {
      const binding = services.cursorAccounts;
      const registry = services.accountRegistry;
      if (!binding || !registry) return undefined;
      const env = options.engine?.cursor?.env ?? process.env;
      const driver = cursorSdkLoginDriver(registry, {
        ...options.engine?.cursor,
        now,
        launchEnv: env,
        slots: cursorHosts(context),
        stopInstance: (instanceId) => binding.stopInstance(instanceId),
      });
      return {
        env,
        busy: (instanceId) => services.cursorAuth?.isChangingInstance(instanceId) ?? false,
        fence: (instanceId) => binding.stopInstance(instanceId),
        rebind: (instanceId) => binding.rebindInstance(instanceId),
        status: async (instance) =>
          (await driver.status(instance, context.signal)).status === "logged-in"
            ? "logged_in"
            : "logged_out",
      };
    },
  });
  services.accountManagement = management;
  const initialized = warmup(context, "accountManagement", () => management.initialize());
  resources.own(async () => {
    await initialized;
    await management.close();
  });
}
export function createAccountsSession(context: SocketContext): SocketService {
  let pending = 0;
  return {
    close() {
      const task = context.options.accountManagement?.disconnect(context.sessionId).catch(() => {});
      if (task) {
        context.tasks.add(task);
        void task.finally(() => context.tasks.delete(task));
      }
    },
    handle(message) {
      const management = AccountManagementRequest.safeParse(message);
      if (
        !management.success &&
        message.type !== "accounts.list" &&
        message.type !== "accounts.status" &&
        message.type !== "accounts.migrate"
      )
        return false;
      if (!("requestId" in message)) return false;
      const reject = (code: string, detail: string) =>
        context.fail(
          code,
          detail,
          false,
          message.requestId ? { requestId: message.requestId } : {},
        );
      const scope = management.success
        ? "accounts"
        : message.type === "accounts.migrate"
          ? "operate"
          : "read";
      if (!context.authorize(scope)) reject("forbidden", `${scope} scope required`);
      else if (
        !context.options.accounts ||
        (management.success && !context.options.accountManagement)
      )
        reject("accounts_unavailable", "Accounts service is unavailable");
      else if (pending >= 8) reject("accounts_busy", "Too many account requests");
      else {
        pending++;
        const task = (
          management.success
            ? (context.options.accountManagement?.handle(context.sessionId, management.data) ??
              Promise.reject(new Error("Accounts unavailable")))
            : context.options.accounts.handle(message)
        )
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
