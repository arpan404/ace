import { ProcessInventory } from "@ace/provider-kit/process-inventory";
import { namedFetch } from "@ace/client/ace-client";
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
import { randomBytes, randomUUID } from "node:crypto";
import { relayKeysFor } from "./account-access/relay-host-id.ts";
import { machineAccount } from "./account-access/machine-account.ts";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logError, logFields, createHealthMonitor } from "@ace/diagnostics";
import { installFatalLogFlush, installRejectionGuard } from "./fatal-log.ts";
import { isStoreRetry } from "./store-busy.ts";
import { buildFields, daemonLogDirectory, logStartupRefusal, openDaemonLog } from "./daemon-log.ts";
import { logHomeBackup } from "./home-backup-log.ts";
import { lineageFile } from "./sequence-lineage.ts";
import {
  freeBytesOf,
  openAtStart,
  sqliteFailureDetails,
  systemDiskSpace,
} from "./sqlite-failure.ts";
import { StorageWatch, systemStorageDelay } from "./storage-watch.ts";
import { storageReserve } from "./storage-reserve.ts";
import { storageLevels } from "./storage-levels.ts";
import { createLoopMonitor, systemLoopClock } from "./loop-monitor.ts";
import { watchStalls } from "./stall-log.ts";
import { DaemonStop, type StopReason } from "./stop-reason.ts";
import { stopRecorder, type Stopping } from "./stop-record.ts";
import { beginRun, previousRunRecord, type DaemonRun } from "./run-marker.ts";
import { readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";
import { runningBuildId, storedTrustBuild } from "./stored-shape.ts";

import { startServer, type ServerOptions } from "./server.ts";
import { readHomeData } from "./home-data.ts";
import { spawn } from "node:child_process";
import { fileRecord } from "./machine-update/record.ts";
import { machineUpdateConfig } from "./machine-update/updater-process.ts";
import { Store } from "./store.ts";
import { Resources } from "./services/resources.ts";
import { serviceFactories, readyServices, type ServiceContext } from "./services/composition.ts";
import { ServiceStartup, systemStartup } from "./services/startup.ts";
import { attemptFile, safeModeSkips, startupAttempts } from "./startup-attempts.ts";
import { crashRecord, installCrashAttribution, repeatedCrashes } from "./service-crashes.ts";
import { ServiceScope } from "./services/service-scope.ts";
import type { DaemonOptions } from "./services/options.ts";
export type { DaemonOptions } from "./services/options.ts";
import { bindLiveServices, daemonHandle, shareDiagnostics } from "./daemon-surface.ts";
import { MaintenanceGate } from "@ace/service";
import { keepUserPause } from "./user-pause.ts";
import { firstLine, loginPathWaitMs, onFinalPath, receiveLoginPath } from "./login-path-handoff.ts";
import { daemonLoginPath } from "@ace/service/login-path";
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
  // When this process began, on the same clock: each startup phase logs how far in it ended.
  const entered = now();
  const spawnedAt = entered - process.uptime() * 1000;
  const sinceSpawn = () => Math.round(now() - spawnedAt);
  const config = options.config ?? readConfig();
  // Started by the desktop app on last launch's PATH: the login shell's follows on stdin, or
  // the daemon asks the shell itself (`login-path-handoff.ts`).
  // Aborted as the daemon stops (below): ends a lookup still waiting on a slow shell, and its
  // processes, inside the shutdown budget.
  const loginPathStop = new AbortController();
  if (!options.loginPath) {
    const loginPath = receiveLoginPath({
      env: process.env,
      read: () => firstLine(process.stdin, { signal: loginPathStop.signal }),
      timeout: () => new Promise((settle) => setTimeout(settle, loginPathWaitMs).unref()),
      lookup: (pending) => daemonLoginPath(pending, process.env, { signal: loginPathStop.signal }),
      signal: loginPathStop.signal,
    });
    if (loginPath) options = { ...options, loginPath };
  }
  // The doctor and toolchains find CLIs on PATH: only on the final one.
  const pathFinal = options.loginPath?.final;
  const diagnostics = options.diagnostics ?? {
    doctor: () =>
      onFinalPath(pathFinal, loginPathStop.signal, () =>
        connectedDoctorReport(config, process.env, now),
      ),
    toolchains: () =>
      onFinalPath(pathFinal, loginPathStop.signal, () =>
        daemonToolchains(process.env, process.platform, daemonServeSim(config.dataDir)),
      ),
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
  // A disk already full: ace's reserve goes before anything else opens, so the log, the stores
  // and their first writes have room (ADR 0176). The storage watch holds new work from here.
  const reserve = storageReserve(config.dataDir);
  const free = freeBytesOf(config.dataDir, diskSpace);
  if (free !== null && free < (options.storageWatch?.levels ?? storageLevels).pauseBelow)
    reserve.release();
  let log: Awaited<ReturnType<typeof openDaemonLog>>;
  try {
    log = await openDaemonLog(config, context, now);
  } catch (error) {
    unlock();
    throw error;
  }
  const resources = new Resources();
  resources.own(() => log.close(), "daemon log");
  // A full disk holds new work and heals on its own once space is back (ADR 0176).
  const storage = new StorageWatch({
    home: config.dataDir,
    diskSpace,
    log,
    delay: systemStorageDelay,
    reserve,
    ...options.storageWatch,
  });
  resources.own(() => storage.close(), "storage watch");
  if (prepared.state === "fresh") {
    const followUp = new AbortController();
    resources.own(() => followUp.abort(), "home backup log");
    // logHomeBackup() logs its own outcome, including a failure to describe the backup.
    void logHomeBackup(prepared, log, new Date(now()), followUp.signal).catch(() => {});
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
  log.log(
    "info",
    "Daemon modules loaded",
    logFields([["sinceSpawnMs", Math.round(entered - spawnedAt)]]),
  );
  resources.own(
    installFatalLogFlush(process, log, (error) =>
      sqliteFailureDetails(error, config.dataDir, diskSpace),
    ),
  );
  // A rejection nobody caught is logged and the daemon keeps running. A full disk is entered as
  // a condition and heals on its own, like contention.
  resources.own(
    installRejectionGuard(
      process,
      log,
      (reason) => storage.observe(reason) || isStoreRetry(reason),
      now,
    ),
  );
  // A fatal error is charged to the service whose code raised it, for safe mode (ADR 0175).
  const scope = new ServiceScope();
  const crashes = crashRecord(attemptFile(join(config.dataDir, "service-crashes.json")));
  resources.own(
    installCrashAttribution(
      process,
      () => scope.current(),
      (service) => {
        crashes.record(service, now());
        log.log("error", "Fatal error in service", logFields([["service", service]]));
        log.flushSync();
      },
    ),
  );
  let stopping: Stopping | undefined;
  const stopRecord = stopRecorder({ run: () => run, log, now, pid: process.pid });
  // Disposers run in reverse: this record is the last line before the log closes.
  resources.own(() => {
    if (stopping) stopRecord.stopped(stopping);
  }, "stop record");
  const loop = createLoopMonitor({
    clock: options.loopClock ?? systemLoopClock(process.platform),
    onStall: ({ delayMs, suppressed }) =>
      log.log(
        "warn",
        "Event loop stalled",
        logFields([
          ["delayMs", delayMs],
          ["suppressed", suppressed],
        ]),
      ),
    onSuspend: ({ suspendedMs, suppressed }) =>
      log.log(
        "info",
        "System was suspended",
        logFields([
          ["suspendedMs", suspendedMs],
          ["suppressed", suppressed],
        ]),
      ),
  });
  resources.own(() => loop.close(), "event loop monitor");
  const pauseBelow = (options.storageWatch?.levels ?? storageLevels).pauseBelow;
  let inventory: ProcessInventory;
  try {
    inventory = openAtStart(
      () =>
        new ProcessInventory(join(config.dataDir, "processes.sqlite"), undefined, (error) => {
          if (!storage.observe(error))
            log.log("warn", "Process inventory write failed; retrying", logError(error));
        }),
      config.dataDir,
      diskSpace,
      pauseBelow,
    );
  } catch (error) {
    loop.close();
    await log.close();
    unlock();
    throw error;
  }
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
  const stopRetrying = storage.onRoom(() => inventory.retryRemovals());
  resources.own(() => {
    stopRetrying();
    stopInventory();
    inventory.close();
  }, "process inventory");
  resources.own(
    watchStalls(log, daemonLogDirectory(config), options.stallTiming),
    "stall watchdog",
  );
  const lifetime = new AbortController();
  resources.onShutdown(() => lifetime.abort());
  // After `lifetime`: whatever waited on the final PATH wakes to a stopping daemon.
  resources.onShutdown(() => loginPathStop.abort());
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
    const storeBegan = now();
    const eventStore = openAtStart(
      () =>
        new Store(
          join(config.dataDir, "events.sqlite"),
          (error) => {
            storage.observe(error);
            log.log("error", "Event subscriber failed", logError(error));
          },
          // Beside the database, outside it: a rolled-back database is named afresh (ADR 0128).
          {
            now,
            lineage: lineageFile(join(config.dataDir, "sequence-mark.json")),
            storedTrustBuild: storedTrustBuild(
              process.env.ACE_VERSION,
              process.argv[1] === undefined ? undefined : runningBuildId(dirname(process.argv[1])),
            ),
          },
        ),
      config.dataDir,
      diskSpace,
      pauseBelow,
    );
    log.log(
      "info",
      "Event store opened",
      logFields([
        ["durationMs", Math.round(now() - storeBegan)],
        ["sinceSpawnMs", sinceSpawn()],
      ]),
    );
    // One admission gate for the server and the engine, closed before any service starts when
    // maintenance was asked for, so startup recovery honours it too (ADR 0041).
    const maintenance = new MaintenanceGate(
      () => eventStore.updateBlockers(),
      () => eventStore.waitingBlockers(),
    );
    // The person's pause outlives a restart until they resume.
    const stopKeepingPause = keepUserPause(maintenance, join(config.dataDir, "paused"), (error) =>
      log.log("warn", "Couldn't save the pause", logError(error)),
    );
    resources.own(stopKeepingPause, "pause marker");
    // A restart in the middle of an update keeps the update's hold (ADR 0041).
    if (process.env.ACE_MAINTENANCE === "1") maintenance.enter("update");
    resources.own(storage.attach(maintenance), "storage hold");
    storage.start();
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
      diskFull: storage,
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
    // Safe mode leaves off what the last run was stuck starting (ADR 0175).
    const attempts = startupAttempts(attemptFile(join(config.dataDir, "startup-attempts.json")));
    const skip = config.safeMode
      ? safeModeSkips(attempts.previous, serviceFactories, repeatedCrashes(crashes.previous, now()))
      : [];
    if (config.safeMode)
      log.log("warn", "Daemon starting in safe mode", logFields([["services", skip]]));
    const startup = new ServiceStartup(
      serviceContext,
      {
        ...systemStartup,
        onAttempt: attempts.onAttempt,
        inService: (name, work) => scope.run(name, work),
        ...options.startup,
      },
      skip,
    );
    await startup.start(serviceFactories);
    const services = serviceContext.services;
    readyServices(services);
    const handler = services.handler;
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    const account = machineAccount({
      dataDir: config.dataDir,
      codes: store.machineCodes,
      // Every call this makes goes to ace's account backend, so each names the daemon.
      fetch: namedFetch(globalThis.fetch, config.aceClient),
      now,
      randomBytes,
      delay: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      },
      defaultOrigin: config.accountOrigin,
      relayKeys: () => relayKeysFor(config.dataDir),
      log: (error) => log.log("warn", "ace account", logError(error)),
    });
    await account.load();
    services.marketAgent?.bindAccount(account);
    resources.own(() => account.close(), "ace account");

    const socketReady = Promise.withResolvers<void>();
    resources.onShutdown(() => socketReady.resolve());
    const serverOptions: ServerOptions = {
      lifetime: lifetime.signal,
      shutdown: shutdownControl(config.dataDir, {
        id: randomUUID,
        now,
        close: () => closeResources({ source: "stop-request" }),
      }),
      ...services,
      get promptFiles() {
        return services.promptFiles;
      },
      // Published once a service first starts ace-media.
      get mediaAcceleration() {
        return services.mediaAcceleration;
      },
      get skillLibrary() {
        return services.skillLibrary;
      },
      get commands() {
        return services.commands;
      },
      handler,
      serviceStatus: startup.status,
      serviceChanges: startup.onChange,
      eventLoop: loop.status,
      ready: socketReady.promise,
      remoteConfig: config,
      machineAccount: account,
      webRoot: existsSync(resolve(import.meta.dirname, "web/index.html"))
        ? resolve(import.meta.dirname, "web")
        : resolve(import.meta.dirname, "../../web/dist"),
      maintenance: process.env.ACE_MAINTENANCE === "1",
      maintenanceGate: maintenance,
      version: process.env.ACE_VERSION ?? "development",
      homeData: () => readHomeData(config.dataDir),
      machineUpdate: machineUpdateConfig({
        dataDir: config.dataDir,
        entry: process.argv[1],
        node: process.execPath,
        platform: process.platform,
        env: process.env,
        spawn,
        record: fileRecord(config.dataDir),
      }),
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
      log: (error) => {
        // Shutdown aborts socket work in flight: that cancellation is expected, not a failure.
        if (lifetime.signal.aborted && error instanceof Error && error.name === "AbortError")
          return;
        log.log("error", "WebSocket failure", logError(error));
      },
      warn: (message, fields) => log.log("warn", message, fields),
      info: (message, fields) => log.log("info", message, fields),
    };
    bindLiveServices(serverOptions, services);
    // Late-bound: the lifecycle exists once the server below has started its transports.
    services.threadDeletion = async (command) => {
      const lifecycle = serverOptions.threadLifecycle;
      if (!lifecycle) return { commandId: command.id, ok: false, error: "not_ready" };
      return lifecycle.delete(command);
    };
    lifetime.signal.throwIfAborted();
    const serverBegan = now();
    server = await startServer(serverOptions);
    lifetime.signal.throwIfAborted();
    log.log(
      "info",
      "Daemon listening",
      logFields([
        ["url", server.url],
        ["durationMs", Math.round(now() - serverBegan)],
        ["sinceSpawnMs", sinceSpawn()],
        ...build,
      ]),
    );
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
