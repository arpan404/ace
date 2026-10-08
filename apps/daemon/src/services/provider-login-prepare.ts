import {
  cursorSdkLoginDriver,
  createInstance,
  instanceEnv,
  assertManagedHome,
  type ProviderLoginDriver,
} from "@ace/accounts";
import type { ProviderKind } from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { discoverProvider, discoverPiStatus } from "@ace/provider-kit/discovery";
import { probeOutput, spawnRawSupervised } from "@ace/provider-kit/process";
import type { TerminalManager } from "@ace/terminal";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import { cliLoginDriver, manualLogin } from "../provider-login-driver.ts";
import { cursorLoginDriver } from "../provider-login-cursor.ts";

import { cursorHosts } from "./cursor-hosts.ts";
import { registerCursorSdkCatalog } from "./cursor-activation.ts";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";

import type { ServiceContext } from "./types.ts";

import { apiKeyLoginDriver, apiKeySupport } from "../provider-api-key.ts";
import { cursorApiKeyEntry } from "@ace/adapter-cursor/auth";
export async function prepareProviderLogin(
  context: ServiceContext,
  manager: TerminalManager,
  cursorDefault: { id: string; homeDir: string },
  target: {
    provider: ProviderKind;
    instance?: string;
    method?: "login" | "api_key";
    upstream?: "openai" | "anthropic" | "openrouter" | "opencode";
  },
  action: "login" | "logout",
  signal: AbortSignal,
): Promise<ProviderLoginDriver> {
  const { services, options, now, id, config } = context;
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
    await registry.validateHome(instance);
    signal.throwIfAborted();
    if (services.cursorAuth?.isChangingInstance(instanceId)) throw new Error("SDK auth is busy");
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
    const driver =
      target.method === "api_key" && action === "login"
        ? apiKeyLoginDriver({
            command: process.execPath,
            args: [cursorApiKeyEntry()],
            cwd: instance.homeDir,
            spawn(spawnOptions) {
              const releaseWorker = slots.acquire();
              let worker: ReturnType<typeof spawnRawSupervised> | undefined;
              try {
                const untrack = slots.track(instanceId, async () => {
                  await worker?.stop();
                });
                try {
                  worker = spawnRawSupervised(spawnOptions);
                } catch (error) {
                  untrack();
                  throw error;
                }
                void worker.exited.finally(() => {
                  untrack();
                  releaseWorker();
                });
                return worker;
              } catch (error) {
                releaseWorker();
                throw error;
              }
            },
            env: {
              ...instanceEnv(instance, options.engine?.cursor?.env ?? process.env, "cursor-sdk"),
              CURSOR_API_KEY: undefined,
              NODE_OPTIONS: undefined,
              NODE_PATH: undefined,
            },
          })
        : cursorLoginDriver(instance, account, action);
    return {
      ...driver,
      async run(runSignal, emit) {
        if (target.method === "api_key") {
          await binding.stopInstance(instanceId);
          await slots.stopInstance(instanceId);
          await registry.validateHome(instance);
          runSignal.throwIfAborted();
        }
        return driver.run(runSignal, emit);
      },
      async drain() {
        await driver.drain?.();
        if (target.method === "api_key") await slots.stopInstance(instanceId);
      },
      release,
      async changed(changeSignal) {
        registry.recordAuth(
          instanceId,
          action === "logout" ? "unknown" : target.method === "api_key" ? "api_key" : "browser",
        );
        if (target.method === "api_key") await account.status(instance, changeSignal);
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
                    "--with-api-key",
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
    const supportedKey = apiKeySupport(target.provider, status.version, help);
    if (target.method === "api_key" && !supportedKey.supported)
      throw new Error("API key unsupported");
    if (target.method === "api_key" && provider === "opencode" && !target.upstream)
      throw new Error("Choose an upstream");
    const driver =
      target.method === "api_key" && action === "login"
        ? apiKeyLoginDriver({
            command: status.path,
            args:
              provider === "codex"
                ? ["login", "--with-api-key"]
                : [
                    "auth",
                    "login",
                    "--provider",
                    target.upstream ?? "openai",
                    "--method",
                    "Manually enter API Key",
                  ],
            cwd: instance.implicit ? config.dataDir : instance.homeDir,
            env,
            ...(provider === "opencode" ? { prompt: true } : {}),
          })
        : cliLoginDriver({
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
        if (action === "logout" && after.auth !== "logged_out")
          throw new Error("CLI logout unconfirmed");
        if (action === "login" && after.auth === "logged_out")
          throw new Error("CLI is still signed out");
        registry.recordAuth(
          instanceId,
          action === "logout" ? "unknown" : target.method === "api_key" ? "api_key" : "browser",
          target.method !== "api_key" ? after.accountLabel : undefined,
        );
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
}
