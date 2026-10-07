import { instanceEnv, cursorSdkLoginDriver } from "@ace/accounts";
import { createCursorAccountDriver } from "@ace/adapter-cursor/auth";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import { ProviderStatuses } from "../provider-status.ts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { cursorHosts } from "./cursor-hosts.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startProviderStatuses(context: ServiceContext): void {
  const cursor = context.options.engine?.cursor;
  const driverOptions = {
    ...cursor,
    limits: { ...cursor?.limits, timeoutMs: 4000 },
    slots: cursorHosts(context),
    launchEnv: cursor?.env ?? process.env,
    environment(identity: { id: string; homeDir: string }) {
      const selected = context.services.accountRegistry?.get(identity.id)?.instance;
      if (!selected) return cursor?.env ?? process.env;
      if (selected.provider !== "cursor" || selected.homeDir !== identity.homeDir)
        throw new Error("Cursor SDK status requires its registered home");
      return instanceEnv(selected, cursor?.env ?? process.env, "cursor-sdk");
    },
    stopInstance: async () => {
      throw new Error("Discovery cannot change authentication");
    },
  };
  const driver = createCursorAccountDriver(driverOptions);
  const accountDriver = context.services.accountRegistry
    ? cursorSdkLoginDriver(context.services.accountRegistry, { ...driverOptions, now: context.now })
    : undefined;
  const statuses = new ProviderStatuses(
    {
      ...context.options.providerStatus,
      checked(rows) {
        context.options.providerStatus?.checked?.(rows);
        for (const row of rows)
          if (row.version)
            context.services.models?.installationChanged(row.provider, row.version, row.runtime);
      },
      configuration: (provider) =>
        context.services.providerConfigurations?.for(provider) ?? { provider },
      cursorSdk:
        context.options.providerStatus?.cursorSdk ??
        (async (signal) => {
          const sdk = await discoverCursorSdk(cursor?.discovery);
          const installation = {
            installed: sdk.installed,
            ...(sdk.module ? { path: sdk.module } : {}),
            ...(sdk.version ? { version: sdk.version } : {}),
            auth: "unknown" as const,
            loginHint: "Sign in to Cursor",
          };
          if (!sdk.installed) return installation;
          if (!sdk.supported)
            return { ...installation, error: "Cursor SDK version or runtime unsupported" };
          const selected = context.services.accountRegistry?.selectedCursorSdk();
          const account = selected ? context.services.accountRegistry?.get(selected) : undefined;
          const instance = account?.instance ?? (await daemonCursorInstance(context));
          try {
            if (account) await context.services.accountRegistry?.validateHome(account.instance);
            const status =
              account && accountDriver
                ? await accountDriver.status(account.instance, signal)
                : await driver.status({ id: instance.id, homeDir: instance.homeDir }, signal);
            const revision = context.services.accountRegistry?.get(instance.id)?.instance
              .loginRevision;
            if (
              account &&
              revision &&
              revision !== account.instance.loginRevision &&
              context.services.models?.hasInstance(instance.id)
            )
              void context.services.models
                .loginChanged(instance.id, revision)
                .catch(() => context.log.log("warn", "Cursor model login-change refresh failed"));
            return {
              ...installation,
              auth: status.status === "logged-in" ? "logged_in" : "logged_out",
              authDetail: status.source,
            };
          } catch {
            return { ...installation, error: "Cursor SDK authentication status unavailable" };
          }
        }),
    },
    {
      now: context.now,
      schedule(expire, ms) {
        const timer = setTimeout(expire, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  );
  context.services.providerStatuses = statuses;
  context.resources.own(() => statuses.close());
}
export function createProviderStatusesSession(context: SocketContext): SocketService {
  let pending = 0;
  return {
    async handle(message) {
      if (message.type !== "providers.request") return false;
      const reply = (result: import("@ace/protocol").ProvidersResult["result"]) =>
        context.send({ type: "providers.result", requestId: message.requestId, result });
      if (!context.authorize(message.operation === "refresh" ? "operate" : "read"))
        reply({ ok: false, error: "forbidden" });
      else if (!context.options.providerStatuses) reply({ ok: false, error: "unavailable" });
      else if (pending >= 8) reply({ ok: false, error: "busy" });
      else {
        pending++;
        try {
          if (message.operation === "refresh") await context.options.providerStatuses.refresh();
          if (context.connected() && context.authorize("read"))
            reply({ ok: true, providers: context.options.providerStatuses.list() });
        } finally {
          pending--;
        }
      }
      return true;
    },
  };
}
