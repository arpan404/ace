import {
  ProviderLoginSessions,
  cursorSdkLoginDriver,
  createInstance,
  instanceEnv,
  assertManagedHome,
  type ProviderLoginDriver,
} from "@ace/accounts";
import { ProviderLoginRequest, OnboardingRequest } from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { discoverProvider, discoverPiStatus } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import { createPosixBackendFactory, TerminalManager } from "@ace/terminal";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import { cliLoginDriver, manualLogin } from "../provider-login-driver.ts";
import { cursorLoginDriver } from "../provider-login-cursor.ts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { cursorHosts } from "./cursor-hosts.ts";
import { registerCursorSdkCatalog } from "./cursor-activation.ts";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { registerImplicitAccounts } from "../account-homes.ts";
import { Onboarding } from "../onboarding.ts";
import { join } from "node:path";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export async function startProviderLogin(context: ServiceContext): Promise<void> {
  const { services, options, resources, now, id, config } = context;
  if (services.accountRegistry)
    await registerImplicitAccounts(
      services.accountRegistry,
      options.accounts?.env ?? options.providerStatus?.env ?? process.env,
    );
  const manager = new TerminalManager({
    ...options.accounts?.terminal,
    dependencies: {
      backendFactory: createPosixBackendFactory(undefined, config.dataDir),
      ...options.accounts?.terminal?.dependencies,
    },
  });
  const cursorDefault = await daemonCursorInstance(context);
  const sessions = new ProviderLoginSessions({
    instanceKey(provider, instance) {
      return provider === "cursor"
        ? (cursorInstanceId(instance) ??
            services.accountRegistry?.selectedCursorSdk() ??
            cursorDefault.id)
        : instance === `${provider}-cli-default`
          ? "default"
          : instance;
    },
    now,
    id,
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    async prepare(target, action, signal) {
      const registry = services.accountRegistry;
      if (!registry || !services.accounts) throw new Error("Accounts unavailable");
      if (target.provider === "acp" || target.provider === "antigravity") {
        const manual = manualLogin(target.provider, action, target.instance);
        return {
          run: async () => ({
            success: false,
            manual,
          }),
        };
      }
      const configuration = services.providerConfigurations?.for(target.provider, target.instance);
      if (configuration?.enabled === false) throw new Error("Provider disabled");
      if (target.provider === "cursor") {
        const sdk = await discoverCursorSdk(options.engine?.cursor?.discovery);
        signal.throwIfAborted();
        if (!sdk.supported) throw new Error("SDK unavailable");
        await services.providerActivation;
        signal.throwIfAborted();
        const binding = services.cursorAccounts;
        if (!binding) throw new Error("SDK unavailable");
        const instanceId =
          cursorInstanceId(target.instance) ?? registry.selectedCursorSdk() ?? cursorDefault.id;
        if (!registry.get(instanceId) && instanceId === cursorDefault.id)
          await registry.register(
            createInstance({ ...cursorDefault, provider: "cursor", label: "Cursor" }),
          );
        const instance = registry.get(instanceId)?.instance;
        if (!instance || instance.provider !== "cursor" || instance.implicit)
          throw new Error("SDK requires an SDK instance");
        if (services.cursorAuth?.isChangingInstance(instanceId))
          throw new Error("SDK auth is busy");
        const slots = cursorHosts(context);
        const release = services.accounts.reserveAccountChange(instanceId);
        const before = instance.loginRevision;
        const account = cursorSdkLoginDriver(registry, {
          ...options.engine?.cursor,
          now,
          launchEnv: options.engine?.cursor?.env ?? process.env,
          slots,
          stopInstance: (accountId) => binding.stopInstance(accountId),
        });
        return {
          ...cursorLoginDriver(instance, account, action),
          release,
          async changed() {
            if (registry.get(instanceId)?.instance.loginRevision === before)
              registry.loginChanged(instanceId);
            if (registry.get(instanceId)?.quota.cursorSdkAuth?.status === "logged-in")
              await binding.rebindInstance(instanceId);
            registerCursorSdkCatalog(context, instance);
            await services.models?.loginChanged(
              instanceId,
              registry.get(instanceId)?.instance.loginRevision ?? id(),
            );
            await services.providerStatuses?.refresh();
            services.providerStatuses?.publish();
          },
        };
      }
      const provider = target.provider;
      const instanceId = target.instance ?? `${target.provider}-cli-default`;
      const instance = registry.get(instanceId)?.instance;
      if (
        !instance ||
        instance.provider !== target.provider ||
        (!instance.implicit && !instance.managed)
      )
        throw new Error("Instance unavailable");
      const release = services.accounts.reserveAccountChange(instanceId);
      try {
        if (!instance.implicit) await assertManagedHome(config.dataDir, instance);
        const env = instanceEnv(
          instance,
          options.accounts?.env ?? options.providerStatus?.env ?? process.env,
        );
        const discovery = {
          ...options.providerStatus,
          ...options.accounts?.discovery,
          env,
          signal,
          timeoutMs: 4000,
          ...(configuration?.binaryPath
            ? {
                overrides: {
                  ...options.accounts?.discovery?.overrides,
                  [target.provider]: configuration.binaryPath,
                },
              }
            : {}),
        };
        const status =
          target.provider === "pi"
            ? await discoverPiStatus({
                ...discovery,
                ...(configuration?.binaryPath ? { executable: configuration.binaryPath } : {}),
              })
            : await discoverProvider(target.provider, discovery);
        if (!status.path) throw new Error("CLI not installed");
        const args =
          target.provider === "claude" || target.provider === "opencode"
            ? ["auth", action, "--help"]
            : [action, "--help"];
        const help =
          target.provider === "pi"
            ? ""
            : await (async () => {
                try {
                  const result = await probeOutput(status.path ?? "", args, {
                    env,
                    signal,
                    timeoutMs: 4000,
                  });
                  return result.code === 0
                    ? [
                        "login",
                        "logout",
                        "--device-auth",
                        "--claudeai",
                        "--no-browser",
                        "--provider",
                        "--method",
                      ]
                        .filter((hint) => result.stdout.includes(hint))
                        .join(" ")
                    : "";
                } catch {
                  return "";
                }
              })();
        signal.throwIfAborted();
        if (!instance.implicit) await assertManagedHome(config.dataDir, instance);
        const driver = cliLoginDriver({
          provider: target.provider,
          action,
          ...(target.instance ? { instance: target.instance } : {}),
          command: status.path,
          ...(status.version ? { version: status.version } : {}),
          help,
          cwd: instance.implicit ? config.dataDir : instance.homeDir,
          env,
          manager,
        });
        const result: ProviderLoginDriver = {
          ...driver,
          release,
          async changed(changeSignal) {
            if (!instance.implicit) await assertManagedHome(config.dataDir, instance);
            const after =
              provider === "pi"
                ? await discoverPiStatus({ ...discovery, signal: changeSignal })
                : await discoverProvider(provider, { ...discovery, signal: changeSignal });
            if (action === "login" && after.auth === "logged_out")
              throw new Error("CLI is still signed out");
            const before = registry.get(instanceId)?.instance.loginRevision;
            registry.ingest(instanceId, {
              provider: instance.provider,
              payload: new ProviderPayload(
                JSON.stringify({
                  auth: after.auth,
                  ...("authDetail" in after ? { authDetail: after.authDetail } : {}),
                }),
              ),
              observedAt: now(),
              timeZone: "UTC",
            });
            if (registry.get(instanceId)?.instance.loginRevision === before)
              registry.loginChanged(instanceId);
            const models = services.models;
            if (models) {
              models.registerInstance({
                id: instanceId,
                provider: instance.provider,
                label: instance.label,
                executable: status.path,
                cwd: instance.implicit ? config.dataDir : instance.homeDir,
                ...(instance.implicit
                  ? {}
                  : {
                      env: Object.fromEntries(
                        Object.entries(env).map(([key, value]) => [key, value ?? ""]),
                      ),
                    }),
                loginRevision: registry.get(instanceId)?.instance.loginRevision ?? "0",
              });
              await models.loginChanged(
                instanceId,
                registry.get(instanceId)?.instance.loginRevision ?? "0",
              );
            }
            await services.providerStatuses?.refresh();
            services.providerStatuses?.publish();
          },
        };
        return result;
      } catch (error) {
        release();
        throw error;
      }
    },
  });
  services.providerLogin = sessions;
  resources.own(async () => {
    await sessions.close();
    await manager.closeAll();
  });
  if (services.providerStatuses) {
    const onboarding = new Onboarding(
      join(config.dataDir, "onboarding.sqlite"),
      services.providerStatuses,
    );
    services.onboarding = onboarding;
    resources.own(() => onboarding.close());
  }
}
export function createProviderLoginSession(context: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  let pending = 0;
  const manualTerminals = new Map<string, string>();
  return {
    close() {
      stop?.();
      manualTerminals.clear();
    },
    async handle(message, device) {
      const request = ProviderLoginRequest.safeParse(message);
      if (request.success) {
        const input = request.data;
        const service = context.options.providerLogin;
        const error = !context.authorize("operate")
          ? "forbidden"
          : !service
            ? "unavailable"
            : pending >= 8
              ? "busy"
              : undefined;
        if (error || !service)
          context.send({
            type: "provider.login.result",
            requestId: input.requestId,
            result: { ok: false, error: error ?? "unavailable" },
          });
        else {
          stop ??= service.listen((owner, progress) => {
            if (owner === device && context.connected() && context.authorize("operate"))
              context.send({ type: "provider.login.progress", progress });
          });
          pending++;
          try {
            const result = await service.handle(device, input);
            if (!context.connected() || !context.authorize("operate")) return true;
            if (input.type === "provider.login.terminal" && result.result.ok) {
              const progress = result.result.progress;
              if (
                !progress.manual ||
                progress.state !== "failed" ||
                !context.options.accountManagement
              ) {
                result.result = { ok: false, error: "unavailable" };
              } else {
                const terminalId =
                  manualTerminals.get(progress.session) ??
                  context.options.accountManagement.openProviderTerminal(
                    context.sessionId,
                    progress.instance ?? `${progress.provider}-cli-default`,
                    progress.action,
                  );
                if (!manualTerminals.has(progress.session) && manualTerminals.size >= 32) {
                  const oldest = manualTerminals.keys().next().value;
                  if (oldest) manualTerminals.delete(oldest);
                }
                manualTerminals.set(progress.session, terminalId);
                progress.manual.terminalId = terminalId;
              }
            }
            if (context.connected() && context.authorize("operate")) context.send(result);
          } catch {
            if (context.connected() && context.authorize("operate"))
              context.send({
                type: "provider.login.result",
                requestId: input.requestId,
                result: { ok: false, error: "unavailable" },
              });
          } finally {
            pending--;
          }
        }
        return true;
      }
      const onboarding = OnboardingRequest.safeParse(message);
      if (!onboarding.success) return false;
      const input = onboarding.data;
      const service = context.options.onboarding;
      if (!context.authorize(input.type === "onboarding.dismiss" ? "operate" : "read"))
        context.send({
          type: "onboarding.result",
          requestId: input.requestId,
          result: { ok: false, error: "forbidden" },
        });
      else if (!service)
        context.send({
          type: "onboarding.result",
          requestId: input.requestId,
          result: { ok: false, error: "unavailable" },
        });
      else {
        try {
          if (input.type === "onboarding.dismiss") service.dismiss(device, input.dismissed);
          context.send(service.query(device, input.requestId));
        } catch {
          context.send({
            type: "onboarding.result",
            requestId: input.requestId,
            result: { ok: false, error: "unavailable" },
          });
        }
      }
      return true;
    },
  };
}
