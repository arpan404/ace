import { agentAnswerRefusal } from "../answer-gate.ts";
import { builtinSkillRecovery } from "../builtin-skill-roots.ts";
import { historyEnginePort, historySessionContext } from "./history-engine.ts";
import { configuredAdapter } from "../provider-admission.ts";
import { stagedDiscovery } from "../provider-discovery.ts";
import { logError, logFields } from "@ace/diagnostics";
import { cursorHosts } from "./cursor-hosts.ts";
import { openCursorMcp } from "./cursor-mcp.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { AgentId } from "@ace/protocol";
import { withDaemonMcp, withShippedSkills } from "./provider-mcp.ts";
import { withNativeTools } from "./native-tools.ts";
import { cachedToolFiles, nodeFileSystem } from "../native-tools/files.ts";
import { acpEngineOptions } from "../acp-engine.ts";
import { ManagedWorktrees } from "../managed-worktrees.ts";
import { daemonClaudeAdapter } from "./claude.ts";
import { registerAntigravity } from "./antigravity.ts";
import { registerPi } from "./pi.ts";
import { AccountProvider } from "@ace/protocol/accounts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { cursorCheckpointLimitOverride } from "./cursor-limits.ts";
import { antigravityIdentity, bindCursorSdk, createInstance } from "@ace/accounts";
import { activateCursorProvider } from "./cursor-activation.ts";
import { adapterWarning, type ProviderAdapter } from "@ace/engine-api";
import { recoveryPorts, prepareQueuedInput } from "./recovery.ts";
import { recoverOnFreshReadings } from "./limit-recovery.ts";
import { Engine } from "../engine/index.ts";
import { accessDefaults } from "../engine/access-defaults.ts";
import { projectAccess } from "../project-access.ts";
import { discoverAdapters, settleAll } from "../engine/adapters.ts";
import { AdapterRegistry } from "../engine/registry.ts";
import { activateProviders, discoverThenBind, engineReadiness } from "./provider-activation.ts";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { ServiceContext } from "./types.ts";
export async function startEngine(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services, log } = context;

  if (options.handler) {
    services.startupProbes?.close();
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
    // Live per-thread checkpoint budget from Settings → Providers → Cursor
    // (per-account rows override the provider default). Read on every open.
    limitsForSession: (instanceId?: string) =>
      cursorCheckpointLimitOverride(services.providerConfigurations?.for("cursor", instanceId)),
  };
  // Adapters register once each CLI's path and version are read; its login follows, since
  // OpenCode's login probe alone takes most of a second and nothing at startup needs it.
  const logins = new Map<"claude" | "codex" | "opencode", DiscoveryResult>();
  let target: AdapterRegistry | undefined;
  const loginRead = (provider: "claude" | "codex" | "opencode", cli: DiscoveryResult) => {
    logins.set(provider, cli);
    target?.refreshDiscovery(provider, cli);
  };
  // Adapters join this registry as discovery finds them; every session open waits for
  // `providerActivation` first, so none opens on an adapter that is not bound yet.
  const registry = engineOptions.registry ?? new AdapterRegistry();
  if (!engineOptions.registry) resources.own(() => registry.close(), "provider registry");
  // Once clients can connect, every check observes the CLI afresh (a login may change).
  context.onListen.push(() => services.startupProbes?.close());
  const capabilities = daemonMcpCapabilities(services);
  const worktrees = new ManagedWorktrees(store, config.dataDir);
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
          worktreeSource: (path) => {
            const record = worktrees.get(path);
            return record && worktrees.verify(record.repo, path)?.repo;
          },
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
  const nativeTools = {
    // Read at each launch: settings may start after the engine.
    get settings() {
      return services.settings;
    },
    log,
    env: options.accounts?.env ?? process.env,
    files: cachedToolFiles(nodeFileSystem),
  };
  const bindProvider = (source: ProviderAdapter) => {
    // Innermost, so the person's tool setup applies to whichever account is chosen (ADR 0138).
    const adapter = withNativeTools(
      nativeTools,
      configuredAdapter(source, services.providerConfigurations),
    );
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
      ? configuredAdapter(withShippedSkills(wrapped), services.providerConfigurations)
      : withDaemonMcp(context, wrapped);
  };
  // Provider CLIs, the Cursor SDK and ace's skill folder are read after the engine is up
  // (ADR 0175): a CLI that never answers, or a slow disk, leaves the engine "starting" and
  // commands waiting for their provider instead of failing the daemon's start.
  const activationBegan = context.now();
  const activation = activateProviders({
    signal: context.signal,
    captureSkillRoots: () => builtinSkillRecovery(config.dataDir),
    discover: async () => {
      if (engineOptions.registry) return;
      await discoverAdapters(
        stagedDiscovery(context, loginRead, engineOptions.adapterDiscovery),
        (cli) => daemonClaudeAdapter(context, cli),
        async (adapters) => {
          // Independent providers: Pi's CLI and Antigravity's approved install are read together,
          // and both settle before sessions are bound.
          await settleAll([registerPi(context, adapters), registerAntigravity(context, adapters)]);
        },
        cursorOptions,
        services.providerConfigurations?.for("cursor").enabled === false
          ? async () => ({ installed: false, supported: false })
          : undefined,
        registry,
      ).finally(() => services.startupProbes?.close());
      // Logins read before their adapters registered; later ones apply as they arrive.
      target = registry;
      for (const [provider, cli] of logins) registry.refreshDiscovery(provider, cli);
    },
    bind: async () => {
      try {
        await registerCursorSdkHome();
      } finally {
        registry.bindSessions(bindProvider);
      }
      await activateCursorProvider(context, registry);
    },
    report: (error) => log.log("warn", "Abandoned skill folders unreadable", logError(error)),
  });
  services.providerActivation = activation.settled;
  if (!engineOptions.registry) {
    let update = activation.settled;
    services.rediscoverProviders = () => {
      const discovery = update.then(() =>
        discoverThenBind({
          signal: context.signal,
          discover: () =>
            discoverAdapters(
              stagedDiscovery(context, loginRead, engineOptions.adapterDiscovery),
              (cli) => daemonClaudeAdapter(context, cli),
              async (adapters) => {
                await settleAll([
                  adapters.has("pi") ? Promise.resolve() : registerPi(context, adapters),
                  registerAntigravity(context, adapters),
                ]);
              },
              cursorOptions,
              services.providerConfigurations?.for("cursor").enabled === false
                ? async () => ({ installed: false, supported: false })
                : undefined,
              registry,
            ).then(() => {}),
          bind: async () => {
            try {
              await registerCursorSdkHome();
            } finally {
              registry.bindSessions(bindProvider, { unboundOnly: true });
            }
            await activateCursorProvider(context, registry);
          },
        }),
      );
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
    ...(config.providerIdleMs === undefined ? {} : { idleMs: config.providerIdleMs }),
    ...acp,
    agentHome: config.dataDir,
    ...engineOptions,
    registry,
    providersActivated: activation.settled,
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
    onNamingPrompt(threadId, input) {
      engineOptions.onNamingPrompt?.(threadId, input);
      services.utility?.titles.namingPrompt(threadId, input);
    },
    providerEnabled: (provider, instance) =>
      services.providerConfigurations?.for(provider, instance).enabled !== false,
    ...(aceAction ? { aceToolAction: aceAction } : {}),
    permissionSettings:
      engineOptions.permissionSettings ??
      (async (id) => {
        const thread = store.getThread(id);
        if (!thread) throw new Error("Thread unavailable");
        return accessDefaults({
          project: projectAccess(store, thread.workspaceId),
          daemon: (await services.settings?.get("access.defaultMode"))?.value,
          custom: (await services.settings?.get("access.nativeModes"))?.value[thread.provider],
        });
      }),
    selectInstance:
      engineOptions.selectInstance ??
      ((provider, backend) =>
        backend === "cursor-sdk"
          ? (accounts?.preferredCursorInstance() ?? defaultInstance.id)
          : provider === "antigravity"
            ? // An added Antigravity account the person made the default; else its CLI login.
              accountRegistry?.selectedAcp(antigravityIdentity.acpAgentId)
            : undefined),
    ...(services.workspaceActions
      ? {
          prepareWorkspace: (id, policy) =>
            services.workspaceActions?.prepare(id, policy) ??
            Promise.reject(new Error("Workspace unavailable")),
          assertWorkspaceAvailable: async (cwd, threadId) => {
            await engineOptions.assertWorkspaceAvailable?.(cwd, threadId);
            if (!services.workspaceActions) throw new Error("Workspace unavailable");
            // A gone checkout says so before Git is asked to lock a folder that isn't there.
            await services.workspaceActions.assertCheckoutPresent(threadId, cwd);
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
          session: lease.session,
          changes: lease.changes,
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
        // stderr, and an adapter's own bookkeeping that hit a limit, are worth a warning.
        const warnings = raw.filter(
          (payload) => payload.type === "stderr" || payload.type === adapterWarning,
        );
        const evidence = config.logLevel === "debug" ? raw : warnings;
        if (!evidence.length) return;
        log.log(
          warnings.length ? "warn" : "debug",
          "Provider diagnostic",
          logFields([
            ["thread", thread],
            ["raw", evidence.slice(0, 8).map((payload) => log.metadata(payload))],
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
    onSettleCleanupFailure:
      engineOptions.onSettleCleanupFailure ??
      ((thread, error) =>
        log.log("warn", `Stopping settled thread ${thread} failed`, logError(error))),
  });
  resources.own(() => engine.close(), "provider sessions");
  // Turns deferred while maintenance held new work start when it reopens.
  const stopReopen = context.maintenance?.onReopen(() => engine.admissionReopened());
  if (stopReopen) resources.own(() => stopReopen());
  // Skill folders the last run left are removed once recovery has reattached what still runs;
  // each projection's kernel process lease separately gates deletion.
  const reportCleanup = (error: unknown) =>
    log.log("warn", "Abandoned skill projection cleanup failed", logError(error));
  void activation.skillRoots
    .then((recoverSkillRoots) => recoverSkillRoots?.(engine.ready(), reportCleanup, context.signal))
    .catch(reportCleanup);
  const readEngine = engineReadiness(activation, engine.ready());
  context.readiness?.(readEngine);
  // One line once providers are read and recovery has run: what kept the engine starting.
  const settledAt = (step: Promise<void>) =>
    step.then(
      () => context.now() - activationBegan,
      () => context.now() - activationBegan,
    );
  void Promise.all([settledAt(activation.settled), settledAt(engine.ready())]).then(
    ([providersMs, recoveryMs]) => {
      if (context.signal.aborted) return;
      const state = readEngine();
      log.log(
        state.state === "degraded" ? "warn" : "info",
        "Engine ready",
        logFields([
          ["state", state.state],
          ["providersMs", Math.round(providersMs)],
          ["recoveryMs", Math.round(recoveryMs)],
          ...(state.state === "degraded" ? [["error", state.error] as const] : []),
        ]),
      );
    },
  );
  // The reader changes on its own as providers and recovery settle: say so each time.
  for (const step of [activation.settled, engine.ready()])
    void step.then(
      () => context.readiness?.(readEngine),
      () => context.readiness?.(readEngine),
    );
  engine.bindHostInteractions(
    (command) =>
      // Agents never answer the person's requests: approvals, plans, elicitations.
      agentAnswerRefusal(command, (id) => store.getInteraction(id)?.request.kind) ??
      services.asks?.resolve(command) ??
      services.browserHelp?.resolve(command) ??
      services.marketAgent?.requests.resolve(command),
  );
  services.engine = engine;
  if (accountRegistry)
    resources.own(
      recoverOnFreshReadings({
        subscribeQuota: (listener) => accountRegistry.subscribeQuota(listener),
        quota: (id) => accountRegistry.get(id)?.quota,
        recovered: (id) => engine.accountRecovered(id),
        now: context.now,
        onError: (error) => log.log("warn", "Limit recovery deferred", logError(error)),
      }),
    );
  services.historyAdapters = historyEnginePort(context, engine, registry);
  services.handler = engine.handler;
}

export { createEngineSession } from "./creation-session.ts";
