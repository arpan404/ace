import { historyEnginePort, historySessionContext } from "./history-engine.ts";
import { configuredAdapter } from "../provider-admission.ts";
import { configuredDiscovery } from "../provider-discovery.ts";
import { logError, logFields, logMetadata } from "@ace/diagnostics";
import { cursorHosts } from "./cursor-hosts.ts";
import { openCursorMcp } from "./cursor-mcp.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { AgentId } from "@ace/protocol";
import { withDaemonMcp } from "./provider-mcp.ts";
import { acpEngineOptions } from "../acp-engine.ts";
import { daemonClaudeAdapter } from "./claude.ts";
import { registerAntigravity } from "./antigravity.ts";
import { registerPi } from "./pi.ts";
import { AccountProvider } from "@ace/protocol/accounts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { bindCursorSdk, createInstance } from "@ace/accounts";
import { activateCursorProvider } from "./cursor-activation.ts";
import type { ProviderAdapter } from "@ace/engine-api";
import { recoveryPorts, prepareQueuedInput } from "./recovery.ts";
import { Engine } from "../engine/index.ts";
import { discoverAdapters } from "../engine/adapters.ts";
import type { ServiceContext } from "./types.ts";
export async function startEngine(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services, log } = context;

  if (options.handler) {
    services.handler = options.handler;
    return;
  }
  const engineOptions = options.engine ?? {};
  const defaultInstance = await daemonCursorInstance(context);
  const cursorOptions = {
    ...engineOptions.cursor,
    instance: defaultInstance,
    slots: cursorHosts(context),
    mcp: engineOptions.cursor?.mcp ?? ((session) => openCursorMcp(context, session)),
  };
  const registry =
    engineOptions.registry ??
    (await discoverAdapters(
      configuredDiscovery(context, engineOptions.adapterDiscovery),
      (cli) => daemonClaudeAdapter(context, cli),
      async (adapters) => {
        await registerPi(context, adapters);
        await registerAntigravity(context, adapters);
      },
      cursorOptions,
      services.providerConfigurations?.for("cursor").enabled === false
        ? async () => ({ installed: false, supported: false })
        : undefined,
    ));
  if (!engineOptions.registry) resources.own(() => registry.close());
  context.signal.throwIfAborted();
  const capabilities = daemonMcpCapabilities(services);
  const acp =
    services.agentRegistry && services.models && services.mcp
      ? acpEngineOptions({
          registry,
          capabilities,
          agents: services.agentRegistry,
          models: services.models,
          mcp: services.mcp,
          store,
          options,
          accounts: services.accounts,
          accountRegistry: services.accountRegistry,
          report: (error) => log.log("error", "ACP metadata failure", logError(error)),
        })
      : {};
  const accounts = services.accounts;
  const accountRegistry = services.accountRegistry;
  // Preserve the SDK adapter's original home when it first enters accounts ownership.
  const registerCursorSdkHome = async () => {
    if (
      accounts &&
      accountRegistry &&
      registry.has("cursor") &&
      registry.get("cursor").adapter.backend === "cursor-sdk" &&
      !accountRegistry.get(defaultInstance.id) &&
      !accountRegistry
        .list()
        .some(({ instance }) => instance.provider === "cursor" && !instance.implicit)
    )
      await accountRegistry.register(
        createInstance({ ...defaultInstance, provider: "cursor", label: "Cursor" }),
      );
  };
  const bindProvider = (source: ProviderAdapter) => {
    const adapter = configuredAdapter(source, services.providerConfigurations);
    if (!accounts || !accountRegistry || !AccountProvider.safeParse(adapter.provider).success)
      return withDaemonMcp(context, {
        ...adapter,
        openSession: async (session) =>
          adapter.openSession((await historySessionContext(context, session)) ?? session),
      });
    const sdkBinding =
      adapter.backend === "cursor-sdk" ? bindCursorSdk(accounts, cursorOptions) : undefined;
    if (sdkBinding) services.cursorAccounts = sdkBinding;
    const bound: ProviderAdapter & { close?(): Promise<void> } =
      sdkBinding ?? accounts.bindAdapter({ ...adapter, create: (_env, _context) => adapter });
    const wrapped: ProviderAdapter = {
      ...adapter,
      ...(bound.close ? { close: () => bound.close?.() ?? Promise.resolve() } : {}),
      async openSession(session) {
        const historyContext = await historySessionContext(context, session);
        if (historyContext) return adapter.openSession(historyContext);
        if (
          adapter.backend === "cursor-sdk" &&
          session.instanceId === defaultInstance.id &&
          !accountRegistry.get(session.instanceId)
        )
          return adapter.openSession(session);
        // Listing the normal CLI home must not enroll existing local sessions
        // in registered-account scheduling. Explicit selection still binds it.
        return session.instanceId ||
          accountRegistry.selectedProvider(adapter.provider) ||
          accountRegistry
            .list()
            .some(({ instance }) => instance.provider === adapter.provider && !instance.implicit)
          ? bound.openSession(session)
          : adapter.openSession(session);
      },
    };
    // Cursor SDK owns its scoped HTTP lease, including account identity.
    return adapter.backend === "cursor-sdk"
      ? configuredAdapter(wrapped, services.providerConfigurations)
      : withDaemonMcp(context, wrapped);
  };
  await registerCursorSdkHome();
  registry.bindSessions(bindProvider);
  await activateCursorProvider(context, registry);
  if (!engineOptions.registry) {
    let update = Promise.resolve();
    services.rediscoverProviders = () => {
      const discovery = update.then(async () => {
        context.signal.throwIfAborted();
        await discoverAdapters(
          configuredDiscovery(context, engineOptions.adapterDiscovery),
          (cli) => daemonClaudeAdapter(context, cli),
          async (adapters) => {
            if (!adapters.has("pi")) await registerPi(context, adapters);
            await registerAntigravity(context, adapters);
          },
          cursorOptions,
          services.providerConfigurations?.for("cursor").enabled === false
            ? async () => ({ installed: false, supported: false })
            : undefined,
          registry,
        );
        await registerCursorSdkHome();
        registry.bindSessions(bindProvider, { unboundOnly: true });
        await activateCursorProvider(context, registry);
      });
      update = discovery.catch((error: unknown) =>
        log.log("warn", "Provider discovery failed", logError(error)),
      );
      services.providerActivation = update;
      return discovery;
    };
    let enabled = new Set(
      (services.providerConfigurations?.current() ?? [])
        .filter((row) => !row.instance && row.enabled === false)
        .map((row) => row.provider),
    );
    const stop = services.providerConfigurations?.listen(() => {
      const disabled = new Set(
        (services.providerConfigurations?.current() ?? [])
          .filter((row) => !row.instance && row.enabled === false)
          .map((row) => row.provider),
      );
      const needsDiscovery =
        [...enabled].some((provider) => !disabled.has(provider)) ||
        (services.providerConfigurations?.current() ?? []).some(
          (row) =>
            !row.instance && row.enabled !== false && row.binaryPath && !registry.has(row.provider),
        );
      enabled = disabled;
      if (!needsDiscovery) return;
      void services.rediscoverProviders?.().catch(() => {});
    });
    resources.own(() => {
      stop?.();
      return update;
    });
  }
  const ports = recoveryPorts(context, (id) => engine.sessionMetadata(id));
  const aceAction = engineOptions.aceToolAction ?? services.mcp?.action;
  const engine = new Engine(store, {
    ...acp,
    ...engineOptions,
    registry,
    waitForProvider:
      engineOptions.waitForProvider ??
      (async (provider) => {
        await services.providerActivation;
        if (
          !registry.has(provider) &&
          services.providerConfigurations?.for(provider).enabled !== false
        )
          await services.rediscoverProviders?.();
      }),
    onModelUnavailable(provider, model, instance) {
      log.log(
        "warn",
        "Selected model unavailable",
        logFields([
          ["code", "model_unavailable"],
          ["provider", provider],
          ["model", model],
          ["instance", instance ?? null],
        ]),
      );
      engineOptions.onModelUnavailable?.(provider, model, instance);
    },
    onCommandEvent(event) {
      engineOptions.onCommandEvent?.(event);
      if (event.type === "session.closed") services.commands?.clearRuntime(event.threadId);
      else
        void services.commands
          ?.updateRuntime(event.threadId, event.data)
          .catch((error) =>
            log.log("warn", "Provider command metadata unavailable", logError(error)),
          );
    },
    ...(services.models ? { models: services.models } : {}),
    providerEnabled: (provider, instance) =>
      services.providerConfigurations?.for(provider, instance).enabled !== false,
    ...(aceAction ? { aceToolAction: aceAction } : {}),
    permissionSettings:
      engineOptions.permissionSettings ??
      (async (id) => {
        const thread = store.getThread(id);
        if (!thread) throw new Error("Thread unavailable");
        const workspace = store.getWorkspace(thread.workspaceId);
        const entry = await services.settings?.get("permissions.providerModes", {
          thread: id,
          ...(workspace ? { workspace: workspace.path } : {}),
        });
        return entry?.value[thread.provider] ?? null;
      }),
    selectInstance:
      engineOptions.selectInstance ??
      ((_provider, backend) =>
        backend === "cursor-sdk"
          ? (accounts?.preferredCursorInstance() ?? defaultInstance.id)
          : undefined),
    ...(services.workspaceActions
      ? {
          prepareWorkspace: (id) =>
            services.workspaceActions?.prepare(id) ??
            Promise.reject(new Error("Workspace unavailable")),
          assertWorkspaceAvailable: async (cwd) => {
            await engineOptions.assertWorkspaceAvailable?.(cwd);
            if (!services.workspaceActions) throw new Error("Workspace unavailable");
            await services.workspaceActions.git.assertMutationAvailable(cwd);
          },
          machine: services.workspaceActions.machine,
          beforeSend: async (threadId, commandId) => {
            await engineOptions.beforeSend?.(threadId, commandId);
            if (!services.workspaceActions) throw new Error("Workspace unavailable");
            await services.workspaceActions.checkpoints.beforeSend(threadId, commandId);
          },
        }
      : {}),
    mcp:
      engineOptions.mcp ??
      ((threadId, agentId, lifetime) => {
        const mcp = services.mcp;
        if (!mcp) throw new Error("MCP unavailable");
        const lease = mcp.openSession(
          {
            sessionId: context.id(),
            threadId,
            agentId: AgentId.parse(agentId),
            capabilities:
              store.getThread(threadId)?.backend === "cursor-sdk"
                ? []
                : daemonMcpCapabilities(context.services),
          },
          lifetime,
        );
        return {
          url: mcp.url,
          bearer: lease.bearer,
          signal: lease.principal.signal,
          end: lease.end,
        };
      }),
    recovery: engineOptions.recovery ?? ports,
    prepareInput: engineOptions.prepareInput ?? prepareQueuedInput(context),
    ...((engineOptions.transitions ?? services.transitions)
      ? { transitions: engineOptions.transitions ?? services.transitions }
      : {}),
    onProviderDiagnostic:
      engineOptions.onProviderDiagnostic ??
      ((thread, raw) => {
        const warnings = raw.filter((payload) => payload.type === "stderr");
        const evidence = config.logLevel === "debug" ? raw : warnings;
        if (!evidence.length) return;
        log.log(
          warnings.length ? "warn" : "debug",
          "Provider diagnostic",
          logFields([
            ["thread", thread],
            ["raw", evidence.slice(0, 8).map((payload) => logMetadata(payload))],
          ]),
        );
      }),
    onSessionOpenFailure: (thread, details, route) => {
      log.log(
        "warn",
        "Provider session opening failed",
        logFields([
          ["thread", thread],
          ["provider", details.provider],
          ["model", route?.model ?? details.model ?? null],
          ["instance", route?.instance ?? null],
          ["backend", route?.backend ?? null],
          ["code", details.code],
          ["title", details.title],
          ["detail", details.detail],
        ]),
      );
      return engineOptions.onSessionOpenFailure?.(thread, details, route);
    },
    onError:
      engineOptions.onError ?? ((error) => log.log("error", "Engine failure", logError(error))),
  });
  resources.own(() => engine.close());
  await engine.ready();
  engine.bindHostInteractions(
    (command) =>
      services.screenApprovals?.resolve(command) ??
      services.browserApprovals?.resolve(command) ??
      services.browserOrigins?.resolve(command),
  );
  services.engine = engine;
  services.historyAdapters = historyEnginePort(context, engine, registry);
  services.browserOrigins?.recover();
  services.screenApprovals?.recover();
  services.browserApprovals?.recover();
  services.handler = engine.handler;
}

export { createEngineSession } from "./creation-session.ts";
