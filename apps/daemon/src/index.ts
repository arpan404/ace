import { ProcessInventory } from "@ace/provider-kit/process-inventory";
import { observeProcessGroups, stopOwnedGroups } from "@ace/provider-kit/process";
import { verifyWindowsRecovery } from "./process-recovery.ts";
import { forceStopAfterPoliteWindow } from "./shutdown-processes.ts";
import { cliControl } from "./services/cli-control.ts";
import { daemonLockedUse } from "./locked-use-installer.ts";
import { privilegedRunnerFromEnv } from "./locked-use-privileged.ts";
export { StorageService } from "./storage/service.ts";
export { planStorageItem, type StorageCandidate } from "./storage/planner.ts";
import { shutdownDeadline } from "./shutdown.ts";
import { shutdownControl } from "./shutdown-receipt.ts";
import { connectedDoctorReport, fixDoctorReport } from "./diagnostics-report.ts";
import { daemonToolchains, daemonServeSim } from "./toolchains.ts";
export { runDaemonProcess } from "./process-daemon.ts";
export { NewerDataError, HOME_FORMAT_VERSION } from "@ace/service";
export { DaemonLockHeldError } from "./local-files.ts";
export type { StopReason } from "./stop-reason.ts";
export { createDaemonCommandLibrary } from "./command-library.ts";
export { connectDaemonCommandEvents, type CommandEventSource } from "./command-events.ts";
export type { DaemonCommandIntegration } from "./services/commands.ts";
import {
  HOME_FORMAT_VERSION,
  NewerDataError,
  assertTestHomeIsolation,
  formatName,
  prepareDaemonHome,
  type PreparedHome,
} from "@ace/service";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { assertModelTestIsolation } from "./models.ts";
import { keepWasmWrappersGeneric } from "./wasm-wrappers.ts";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { logError, logFields, createHealthMonitor } from "@ace/diagnostics";
import { installFatalLogFlush, installRejectionGuard } from "./fatal-log.ts";
import { isStoreRetry } from "./store-busy.ts";
import { buildFields, daemonLogDirectory, logStartupRefusal, openDaemonLog } from "./daemon-log.ts";
import { logHomeBackup } from "./home-backup-log.ts";
import { sqliteFailureDetails, systemDiskSpace } from "./sqlite-failure.ts";
import { createLoopMonitor, systemLoopClock } from "./loop-monitor.ts";
import { watchStalls } from "./stall-log.ts";
import { DaemonStop, type StopReason } from "./stop-reason.ts";
import { stopRecorder, type Stopping } from "./stop-record.ts";
import { beginRun, previousRunRecord, type DaemonRun } from "./run-marker.ts";
import { readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";

import { startServer, type ServerOptions } from "./server.ts";
import { Store } from "./store.ts";
import { Resources } from "./services/resources.ts";
import { serviceFactories, readyServices, type ServiceContext } from "./services/composition.ts";
import { ServiceStartup, systemStartup } from "./services/startup.ts";
import type { DaemonOptions } from "./services/options.ts";
export type { DaemonOptions } from "./services/options.ts";
import { bindLiveServices, daemonHandle, shareDiagnostics } from "./daemon-surface.ts";
import { MaintenanceGate } from "@ace/service";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
export { AgentPreviews } from "./agent-control/owners.ts";
export { DelegationService, type DelegationDependencies } from "./agent-control/delegations.ts";
export type { HandoffGit } from "./agent-control/handoffs.ts";
export {
  createAgentControlPort,
  type AgentControlExtensions,
  type ThreadOwnerOperation,
} from "./agent-control/tools.ts";
export { Store, type StoreOptions } from "./store.ts";
export { readConfig } from "./config.ts";
export type { SearchScheduler } from "./search-runtime.ts";
export {
  createDevThread,
  stubHandler,
  type CommandHandler,
  type CommandContext,
} from "./commands.ts";
export { createDaemonReview, type ReviewPort, type DaemonReviewOptions } from "./review.ts";
export { createDaemonUsage, loadUsageSettings, type UsageCommands } from "./usage.ts";
export type { DaemonPreview, DaemonPreviewOptions } from "./preview.ts";
export { readHistoryInstances, type DaemonHistoryOptions } from "./history.ts";
export type { HistoryAdapterPort } from "./history-continuation.ts";

export async function startDaemon(options: DaemonOptions = {}) {
  options.signal?.throwIfAborted();
  // Before the daemon starts any worker thread: a Node 24 V8 abort (see wasm-wrappers.ts).
  keepWasmWrappersGeneric();
  const home = homedir();
  assertTestHomeIsolation(home);
  const clock = options.engine?.clock;
  const now = clock ? () => clock.now() : Date.now;
  const config = options.config ?? readConfig();
  const diagnostics = options.diagnostics ?? {
    doctor: () => connectedDoctorReport(config, process.env, now),
    toolchains: () =>
      daemonToolchains(process.env, process.platform, daemonServeSim(config.dataDir)),
  };
  const sharedDiagnostics = shareDiagnostics(diagnostics);
  options = { ...options, diagnostics: sharedDiagnostics };
  // Reject test path escapes before optional-service failures can be downgraded to degraded startup.
  if (process.env.ACE_TEST_REAL_HOME) {
    // The home boundary above owns ambient HOME; this check owns other path selectors.
    assertTestEnvironmentIsolation({ ...process.env, HOME: undefined, USERPROFILE: undefined });
    for (const instance of options.history?.instances ?? [])
      assertTestHomeIsolation(instance.homeDir);
    assertModelTestIsolation(options.modelInstances ?? []);
  }
  const context = { home, env: process.env };
  const build = buildFields(process.env, process.pid, formatName(HOME_FORMAT_VERSION));
  // Only a refusal of newer data is logged in the home: that home is ace's, in a format this
  // build knows to leave alone. A home still in use by an older daemon, or one ace may not
  // touch at all, gets nothing written; the error itself says why.
  const refuse = (error: unknown) =>
    error instanceof NewerDataError
      ? logStartupRefusal(config, context, now, error.message, [
          ["storedFormat", error.stored],
          ...build,
        ]).catch(() => {})
      : Promise.resolve();
  // The home's format is settled before anything opens or writes in it, the lock included: a
  // newer format is refused, and an older or unversioned one is set aside for a fresh home.
  let prepared: PreparedHome;
  try {
    prepared = prepareDaemonHome(config.dataDir);
  } catch (error) {
    await refuse(error);
    throw error;
  }
  const unlock = acquireLock(config.dataDir);
  try {
    // Under the lock, again: a newer build may have set this home aside in between.
    prepareDaemonHome(config.dataDir);
  } catch (error) {
    unlock();
    await refuse(error);
    throw error;
  }
  const diskSpace = options.diskSpace ?? systemDiskSpace;
  let log: Awaited<ReturnType<typeof openDaemonLog>>;
  try {
    log = await openDaemonLog(config, context, now);
  } catch (error) {
    unlock();
    throw error;
  }
  const resources = new Resources();
  resources.own(() => log.close(), "daemon log");
  if (prepared.state === "fresh") {
    const followUp = new AbortController();
    resources.own(() => followUp.abort(), "home backup log");
    void logHomeBackup(prepared, log, new Date(now()), followUp.signal);
  }
  // Under the lock: the last run's ending tells an expected restart from a crash.
  let run: DaemonRun | undefined;
  try {
    run = beginRun(config.dataDir, process.pid, now);
    const previous = previousRunRecord(run.previous);
    log.log(previous.level, previous.message, logFields([...previous.fields, ...build]));
  } catch (error) {
    log.log("warn", "Daemon run marker could not be written", logError(error));
  }
  resources.own(
    installFatalLogFlush(process, log, (error) =>
      sqliteFailureDetails(error, config.dataDir, diskSpace),
    ),
  );
  resources.own(installRejectionGuard(process, log, isStoreRetry));
  let stopping: Stopping | undefined;
  const stopRecord = stopRecorder({ run: () => run, log, now, pid: process.pid });
  // Disposers run in reverse: this record is the last line before the log closes.
  resources.own(() => {
    if (stopping) stopRecord.stopped(stopping);
  }, "stop record");
  const loop = createLoopMonitor({
    clock: options.loopClock ?? systemLoopClock,
    onStall: ({ delayMs, suppressed }) =>
      log.log(
        "warn",
        "Event loop stalled",
        logFields([
          ["delayMs", delayMs],
          ["suppressed", suppressed],
        ]),
      ),
  });
  resources.own(() => loop.close(), "event loop monitor");
  const inventory = new ProcessInventory(join(config.dataDir, "processes.sqlite"));
  try {
    inventory.recover();
    if (process.platform === "win32") {
      // The engine decides what the previous run left running only once ended processes are
      // verifiably gone; anything unproven is reported as such, never as stopped.
      const recovery = await verifyWindowsRecovery(inventory);
      if (!recovery.verified) {
        log.log(
          "warn",
          "Previous run's processes could not all be verified as stopped",
          logFields([["unresolved", recovery.unresolved]]),
        );
        options = { ...options, engine: { ...options.engine, previousProcessesUnverified: true } };
      }
    }
  } catch (error) {
    inventory.close();
    loop.close();
    await log.close();
    unlock();
    throw error;
  }
  const stopInventory = observeProcessGroups(inventory);
  resources.own(() => {
    stopInventory();
    inventory.close();
  }, "process inventory");
  resources.own(
    watchStalls(log, daemonLogDirectory(config), options.stallTiming),
    "stall watchdog",
  );
  const lifetime = new AbortController();
  resources.onShutdown(() => lifetime.abort());
  let initialized = false;
  const abortReason = (): StopReason => {
    const reason: unknown = options.signal?.reason;
    return reason instanceof DaemonStop ? reason.reason : { source: "abort" };
  };
  const abort = () => {
    resources.beginShutdown();
    if (initialized) void closeResources(abortReason()).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  resources.own(() => options.signal?.removeEventListener("abort", abort));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let endpointPath: string | undefined;
  let endpointRetired = false;
  const retireEndpoint = () => {
    if (endpointRetired) return;
    endpointRetired = true;
    if (endpointPath) unlinkSync(endpointPath);
  };
  let closing: Promise<void> | undefined;
  const pendingShutdown = () => [
    ...(server?.pendingShutdown() ?? []).map((stage) => `server ${stage}`),
    ...resources.pending(),
  ];
  const closeResources = (reason: StopReason = { source: "close" }) => {
    if (!stopping) {
      stopping = { reason, at: now() };
      log.log(
        "info",
        "Daemon stopping",
        logFields([
          ["source", reason.source],
          ...(reason.signal ? [["signal", reason.signal] as const] : []),
          // A string: the log redactor masks booleans that equal an environment value.
          ...(server
            ? [["admission", server.maintenance.status().draining ? "draining" : "open"] as const]
            : []),
          ...build,
        ]),
      );
    }
    closing ??= disposeResources();
    return closing;
  };
  const disposeResources = async () => {
    resources.beginShutdown();
    const runtime = { ...systemStartup, ...options.startup };
    let disposed = false;
    const disposing = (async () => {
      // Service aborts and cleanup start before socket task drain. Shared store/log
      // disposal follows both, so in-flight work can still record its termination.
      const socketClose = server?.close();
      const results = await Promise.allSettled([socketClose, resources.closeIndependent()]);
      try {
        await resources.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      const errors = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              new Error(`${index === 0 ? "Server" : "Resources"} shutdown failed`, {
                cause: result.reason,
              }),
            ]
          : [],
      );
      if (errors.length) throw new AggregateError(errors, "Daemon shutdown failed");
    })().finally(() => {
      disposed = true;
      try {
        retireEndpoint();
      } finally {
        unlock();
      }
    });
    const cancelForcedStop = forceStopAfterPoliteWindow({
      schedule: runtime.schedule,
      stop: options.stopProcesses ?? stopOwnedGroups,
      log,
      pending: pendingShutdown,
    });
    try {
      await shutdownDeadline(
        "Daemon",
        disposing,
        (expire, milliseconds) => runtime.schedule("shutdown", expire, milliseconds),
        7_000,
      );
    } catch (error) {
      // Name what is still closing while the log can still say so; the process exits next.
      if (stopping && !disposed) {
        stopRecord.overran(stopping, pendingShutdown());
        log.flushSync();
      }
      throw error;
    } finally {
      cancelForcedStop();
      retireEndpoint();
    }
  };
  try {
    const logDirectory = daemonLogDirectory(config);
    lifetime.signal.throwIfAborted();
    const eventStore = new Store(
      join(config.dataDir, "events.sqlite"),
      (error) => log.log("error", "Event subscriber failed", logError(error)),
      { now },
    );
    // One admission gate for the server and the engine, closed before any service starts when
    // maintenance was asked for, so startup recovery honours it too (ADR 0041).
    const maintenance = new MaintenanceGate(() => eventStore.updateBlockers());
    if (process.env.ACE_MAINTENANCE === "1") maintenance.enter();
    const serviceContext: ServiceContext = {
      signal: lifetime.signal,
      config,
      options,
      now,
      id: randomUUID,
      log,
      resources,
      services: {
        handler: {
          handle: (command) => ({ commandId: command.id, ok: false, error: "engine_unavailable" }),
        },
      },
      onListen: [],
      maintenance,
      store: eventStore,
    };
    const store = serviceContext.store;
    resources.own(() => store.close(), "event store");
    const health = createHealthMonitor({
      database: join(config.dataDir, "events.sqlite"),
      now,
      workload: () => {
        const current = options.workload?.() ??
          serviceContext.services.engine?.workload() ?? { activeSessions: null, queues: {} };
        return {
          ...current,
          queues: {
            ...current.queues,
            "daemon.socketInput": server?.diagnosticsQueues().socketInput ?? 0,
            "daemon.healthRequests": server?.diagnosticsQueues().healthRequests ?? 0,
          },
        };
      },
      logs: () => ({ ...log.stats(), directory: logDirectory }),
      streaming: () => store.streamingMetrics(),
    });
    resources.own(() => health.close(), "health monitor");
    const startup = new ServiceStartup(serviceContext, { ...systemStartup, ...options.startup });
    await startup.start(serviceFactories);
    const services = serviceContext.services;
    readyServices(services);
    const handler = services.handler;
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);

    const socketReady = Promise.withResolvers<void>();
    resources.onShutdown(() => socketReady.resolve());
    const serverOptions: ServerOptions = {
      shutdown: shutdownControl(config.dataDir, {
        id: randomUUID,
        now,
        close: () => closeResources({ source: "stop-request" }),
      }),
      ...services,
      get promptFiles() {
        return services.promptFiles;
      },
      get skillLibrary() {
        return services.skillLibrary;
      },
      get commands() {
        return services.commands;
      },
      handler,
      serviceStatus: startup.status,
      eventLoop: loop.status,
      ready: socketReady.promise,
      remoteConfig: config,
      webRoot: existsSync(resolve(import.meta.dirname, "web/index.html"))
        ? resolve(import.meta.dirname, "web")
        : resolve(import.meta.dirname, "../../web/dist"),
      maintenance: process.env.ACE_MAINTENANCE === "1",
      maintenanceGate: maintenance,
      version: process.env.ACE_VERSION ?? "development",
      port: config.port,
      ...(config.webOrigins ? { webOrigins: config.webOrigins } : {}),
      token,
      hostId,
      store,
      cliControl: cliControl(serviceContext),
      lockedUse: daemonLockedUse({
        platform: process.platform,
        env: process.env,
        settings: services.settings,
        ...(() => {
          const runner = privilegedRunnerFromEnv(process.env);
          return runner ? { runner } : {};
        })(),
      }),
      ...(options.preview ? { preview: options.preview } : {}),
      health: health.collect,
      doctorFix: async (assertAuthorized) => {
        const result = await fixDoctorReport(config, process.env, now, { assertAuthorized });
        return {
          ...result,
          report: {
            ...result.report,
            checks: result.report.checks.filter((check) => check.id !== "port"),
          },
        };
      },
      doctor: sharedDiagnostics.doctor,
      toolchains: sharedDiagnostics.toolchains,
      log: (error) => log.log("error", "WebSocket failure", logError(error)),
      warn: (message, fields) => log.log("warn", message, fields),
    };
    bindLiveServices(serverOptions, services);
    lifetime.signal.throwIfAborted();
    server = await startServer(serverOptions);
    lifetime.signal.throwIfAborted();
    log.log("info", "Daemon listening", logFields([["url", server.url], ...build]));
    const path = join(config.dataDir, "daemon-endpoint");
    writeFileSync(path, server.httpUrl, { mode: 0o600 });
    endpointPath = path;
    // Endpoint readiness depends on the listener and core store/command port.
    // Feature activation runs under named bounds without withholding discovery.
    await startup.listening(server);
    lifetime.signal.throwIfAborted();
    initialized = true;
    queueMicrotask(() => socketReady.resolve());
    return daemonHandle({
      server,
      services,
      startup,
      eventLoop: loop.status,
      tokenPath,
      store,
      cliControl: cliControl(serviceContext),
      log,
      pendingShutdown,
      close: (reason?: StopReason) => closeResources(reason),
    });
  } catch (error) {
    if (!lifetime.signal.aborted)
      log.log("error", "Daemon startup failed", logFields([["error", logError(error)], ...build]));
    await closeResources(
      lifetime.signal.aborted ? abortReason() : { source: "startup-failure" },
    ).catch(() => {});
    throw error;
  }
}
