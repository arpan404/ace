import { antigravityDiscovery } from "./antigravity.ts";
import { reportedAuthMethod } from "../provider-account-support.ts";
import { apiKeySupport } from "../provider-api-key.ts";
import { probeOutput } from "@ace/provider-kit/process";
import { instanceEnv, cursorSdkLoginDriver } from "@ace/accounts";
import { createCursorAccountDriver } from "@ace/adapter-cursor/auth";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import { ProviderStatuses } from "../provider-status.ts";
import { hasUnauthenticatedOpenCodeModels } from "../provider-model-availability.ts";
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
      antigravity: (signal) => antigravityDiscovery(context, signal),
      modelsAvailable: () =>
        Boolean(
          context.services.models && hasUnauthenticatedOpenCodeModels(context.services.models),
        ),
      account(row) {
        if (row.provider === "antigravity" && context.services.antigravityAuth)
          return { auth: context.services.antigravityAuth };
        const registry = context.services.accountRegistry;
        const selected =
          registry?.selectedProvider(row.provider) ??
          (row.provider === "cursor" ? "cursor-sdk-default" : `${row.provider}-cli-default`);
        const account = registry?.get(selected);
        if (!account) return {};
        return {
          ...(account.instance.authMethod ? { authMethod: account.instance.authMethod } : {}),
          ...(account.instance.signedInAs ? { accountLabel: account.instance.signedInAs } : {}),
          ...(!account.instance.implicit && account.quota.auth !== "unknown"
            ? { auth: account.quota.auth }
            : {}),
        };
      },
      async authInfo(row, signal) {
        let help = "";
        if (row.path && (row.provider === "codex" || row.provider === "opencode")) {
          try {
            const result = await probeOutput(
              row.path,
              row.provider === "codex" ? ["login", "--help"] : ["auth", "login", "--help"],
              { env: context.options.providerStatus?.env ?? process.env, signal, timeoutMs: 4000 },
            );
            if (result.code === 0) help = result.stdout;
          } catch {
            /* Unsupported until a metadata probe succeeds. */
          }
        }
        return {
          apiKey: apiKeySupport(row.provider, row.version, help),
          authMethod: reportedAuthMethod(row.authDetail),
        };
      },
      async versions(row, signal) {
        const installs = context.services.providerInstalls;
        if (!installs || row.provider === "cursor") return {};
        const plan = await installs.planner.plan(
          { provider: row.provider },
          "update",
          undefined,
          signal,
        );
        return plan.method === "registry"
          ? { latestVersion: plan.latestVersion, updateAvailable: plan.updateAvailable }
          : installs.versions.check(plan, signal);
      },
      attention(row) {
        const registry = context.services.accountRegistry;
        const selected =
          row.runtime === "cursor-sdk"
            ? (registry?.selectedCursorSdk() ?? cursor?.instance?.id ?? "cursor-sdk-default")
            : `${row.provider}-cli-default`;
        return registry?.summary(selected, context.now())?.availability === "exhausted";
      },
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
          const fallback = await daemonCursorInstance(context);
          const selected = context.services.accountRegistry?.selectedCursorSdk() ?? fallback.id;
          const account = context.services.accountRegistry?.get(selected);
          const instance = account?.instance ?? fallback;
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
  let stop: (() => void) | undefined;
  return {
    authenticated(channel) {
      if (channel !== undefined || stop || !context.authorize("read")) return;
      stop = context.options.providerStatuses?.listen((providers) => {
        if (context.connected() && context.authorize("read"))
          context.send({ type: "providers.changed", providers });
      });
    },
    close() {
      stop?.();
    },
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
        const statuses = context.options.providerStatuses;
        const task = (async () => {
          try {
            if (message.operation === "refresh") await statuses.refresh();
            if (context.connected() && context.authorize("read"))
              reply({
                ok: true,
                providers:
                  message.operation === "readiness" ? statuses.readiness() : statuses.list(),
              });
          } catch (error) {
            context.options.log?.(error);
            if (context.connected() && context.authorize("read"))
              reply({ ok: false, error: "unavailable" });
          } finally {
            pending--;
          }
        })().finally(() => context.tasks.delete(task));
        context.tasks.add(task);
      }
      return true;
    },
  };
}
