import type { ProviderSession } from "@ace/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { prunePairingSessionsNow } from "./pairing";
import { ProviderService } from "./provider/Services/ProviderService";
import { withStartupTiming } from "./startupDiagnostics";
import { hasActiveWsClientSessions, pruneWsClientSessionsIfNeeded } from "./wsClientSessions";

const DEFAULT_MAINTENANCE_TICK_MS = 30_000;
const DEFAULT_MAINTENANCE_JOB_TIMEOUT_MS = 15_000;
const DEFAULT_MAINTENANCE_IDLE_MIN_AGE_MS = 60_000;
const DEFAULT_MAINTENANCE_DEEP_IDLE_MIN_AGE_MS = 15 * 60_000;

const DEFAULT_LIGHT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_PAIRING_CLEANUP_INTERVAL_MS = 2 * 60_000;
const DEFAULT_SQLITE_OPTIMIZE_INTERVAL_MS = 30 * 60_000;
const DEFAULT_SQLITE_WAL_PASSIVE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS = 90 * 60_000;

const JOB_INTERVAL_JITTER_RATIO = 0.2;

type MaintenancePhase = "always" | "idle" | "deep-idle";
type MaintenanceJobResult = "ran" | "deferred";

type MaintenanceIdleSnapshot = {
  readonly hasActiveUiClients: boolean;
  readonly providerSessionCount: number;
  readonly busyProviderSessionCount: number;
  readonly idle: boolean;
};

type MaintenanceJobContext = {
  readonly nowMs: number;
  readonly sql: SqlClient.SqlClient | undefined;
  readonly readIdleSnapshot: () => Effect.Effect<MaintenanceIdleSnapshot>;
};

type MaintenanceJob = {
  readonly id: string;
  readonly phase: MaintenancePhase;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  nextRunAtMs: number;
  readonly run: (context: MaintenanceJobContext) => Effect.Effect<MaintenanceJobResult>;
};

const phasePriority: Readonly<Record<MaintenancePhase, number>> = {
  always: 0,
  idle: 1,
  "deep-idle": 2,
};

function parseBoundedIntegerEnv(input: {
  readonly envVarName: string;
  readonly fallback: number;
  readonly minimum: number;
}): number {
  const raw = process.env[input.envVarName];
  if (raw === undefined) {
    return input.fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return input.fallback;
  }
  return Math.max(input.minimum, parsed);
}

function jitteredIntervalMs(intervalMs: number): number {
  const jitterFactor =
    1 + (Math.random() * 2 * JOB_INTERVAL_JITTER_RATIO - JOB_INTERVAL_JITTER_RATIO);
  return Math.max(1, Math.round(intervalMs * jitterFactor));
}

function scheduleNextRun(job: MaintenanceJob, nowMs: number): void {
  job.nextRunAtMs = nowMs + jitteredIntervalMs(job.intervalMs);
}

function scheduleInitialRun(job: MaintenanceJob, nowMs: number): void {
  job.nextRunAtMs = nowMs + Math.floor(Math.random() * Math.max(1, job.intervalMs));
}

function isProviderSessionBusy(session: ProviderSession): boolean {
  return (
    session.status === "running" ||
    session.status === "connecting" ||
    session.activeTurnId !== undefined
  );
}

const makeMaintenanceRuntime = Effect.gen(function* () {
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const providerServiceOption = yield* Effect.serviceOption(ProviderService);

  const maintenanceTickMs = parseBoundedIntegerEnv({
    envVarName: "ACE_MAINTENANCE_TICK_MS",
    fallback: DEFAULT_MAINTENANCE_TICK_MS,
    minimum: 1_000,
  });
  const maintenanceJobTimeoutMs = parseBoundedIntegerEnv({
    envVarName: "ACE_MAINTENANCE_JOB_TIMEOUT_MS",
    fallback: DEFAULT_MAINTENANCE_JOB_TIMEOUT_MS,
    minimum: 1_000,
  });
  const maintenanceIdleMinAgeMs = parseBoundedIntegerEnv({
    envVarName: "ACE_MAINTENANCE_IDLE_MIN_AGE_MS",
    fallback: DEFAULT_MAINTENANCE_IDLE_MIN_AGE_MS,
    minimum: 1_000,
  });
  const maintenanceDeepIdleMinAgeMs = parseBoundedIntegerEnv({
    envVarName: "ACE_MAINTENANCE_DEEP_IDLE_MIN_AGE_MS",
    fallback: DEFAULT_MAINTENANCE_DEEP_IDLE_MIN_AGE_MS,
    minimum: maintenanceIdleMinAgeMs,
  });

  const jobs: Array<MaintenanceJob> = [
    {
      id: "light-memory-prune",
      phase: "always",
      intervalMs: parseBoundedIntegerEnv({
        envVarName: "ACE_MAINTENANCE_LIGHT_CLEANUP_INTERVAL_MS",
        fallback: DEFAULT_LIGHT_CLEANUP_INTERVAL_MS,
        minimum: 5_000,
      }),
      timeoutMs: maintenanceJobTimeoutMs,
      nextRunAtMs: 0,
      run: ({ nowMs }) =>
        Effect.sync(() => {
          pruneWsClientSessionsIfNeeded(nowMs);
          prunePairingSessionsNow(nowMs);
          return "ran" as const;
        }),
    },
    {
      id: "pairing-expired-db-cleanup",
      phase: "idle",
      intervalMs: parseBoundedIntegerEnv({
        envVarName: "ACE_MAINTENANCE_PAIRING_CLEANUP_INTERVAL_MS",
        fallback: DEFAULT_PAIRING_CLEANUP_INTERVAL_MS,
        minimum: 15_000,
      }),
      timeoutMs: maintenanceJobTimeoutMs,
      nextRunAtMs: 0,
      run: ({ nowMs, readIdleSnapshot, sql }) =>
        Effect.gen(function* () {
          if (sql === undefined) {
            return "deferred" as const;
          }
          const idleSnapshot = yield* readIdleSnapshot();
          if (!idleSnapshot.idle) {
            return "deferred" as const;
          }
          return yield* sql`DELETE FROM pairing_sessions WHERE expires_at_ms < ${nowMs}`.pipe(
            Effect.as("ran" as const),
            Effect.catchCause((cause) =>
              Effect.logWarning("maintenance SQL step failed", {
                job: "pairing-expired-db-cleanup",
                cause,
              }).pipe(Effect.as("deferred" as const)),
            ),
          );
        }),
    },
    {
      id: "sqlite-optimize",
      phase: "idle",
      intervalMs: parseBoundedIntegerEnv({
        envVarName: "ACE_MAINTENANCE_SQLITE_OPTIMIZE_INTERVAL_MS",
        fallback: DEFAULT_SQLITE_OPTIMIZE_INTERVAL_MS,
        minimum: 60_000,
      }),
      timeoutMs: maintenanceJobTimeoutMs,
      nextRunAtMs: 0,
      run: ({ readIdleSnapshot, sql }) =>
        Effect.gen(function* () {
          if (sql === undefined) {
            return "deferred" as const;
          }
          const idleSnapshot = yield* readIdleSnapshot();
          if (!idleSnapshot.idle) {
            return "deferred" as const;
          }
          return yield* sql`PRAGMA optimize`.pipe(
            Effect.as("ran" as const),
            Effect.catchCause((cause) =>
              Effect.logWarning("maintenance SQL step failed", {
                job: "sqlite-optimize",
                cause,
              }).pipe(Effect.as("deferred" as const)),
            ),
          );
        }),
    },
    {
      id: "sqlite-wal-passive-checkpoint",
      phase: "idle",
      intervalMs: parseBoundedIntegerEnv({
        envVarName: "ACE_MAINTENANCE_SQLITE_WAL_PASSIVE_INTERVAL_MS",
        fallback: DEFAULT_SQLITE_WAL_PASSIVE_INTERVAL_MS,
        minimum: 30_000,
      }),
      timeoutMs: maintenanceJobTimeoutMs,
      nextRunAtMs: 0,
      run: ({ readIdleSnapshot, sql }) =>
        Effect.gen(function* () {
          if (sql === undefined) {
            return "deferred" as const;
          }
          const idleSnapshot = yield* readIdleSnapshot();
          if (!idleSnapshot.idle) {
            return "deferred" as const;
          }
          return yield* sql`PRAGMA wal_checkpoint(PASSIVE)`.pipe(
            Effect.as("ran" as const),
            Effect.catchCause((cause) =>
              Effect.logWarning("maintenance SQL step failed", {
                job: "sqlite-wal-passive-checkpoint",
                cause,
              }).pipe(Effect.as("deferred" as const)),
            ),
          );
        }),
    },
    {
      id: "sqlite-wal-truncate-checkpoint",
      phase: "deep-idle",
      intervalMs: parseBoundedIntegerEnv({
        envVarName: "ACE_MAINTENANCE_SQLITE_WAL_TRUNCATE_INTERVAL_MS",
        fallback: DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS,
        minimum: 5 * 60_000,
      }),
      timeoutMs: maintenanceJobTimeoutMs,
      nextRunAtMs: 0,
      run: ({ readIdleSnapshot, sql }) =>
        Effect.gen(function* () {
          if (sql === undefined) {
            return "deferred" as const;
          }
          const idleSnapshot = yield* readIdleSnapshot();
          if (!idleSnapshot.idle) {
            return "deferred" as const;
          }
          return yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
            Effect.as("ran" as const),
            Effect.catchCause((cause) =>
              Effect.logWarning("maintenance SQL step failed", {
                job: "sqlite-wal-truncate-checkpoint",
                cause,
              }).pipe(Effect.as("deferred" as const)),
            ),
          );
        }),
    },
  ];

  const nowMs = Date.now();
  for (const job of jobs) {
    scheduleInitialRun(job, nowMs);
  }

  const readIdleSnapshot = (): Effect.Effect<MaintenanceIdleSnapshot> =>
    Effect.gen(function* () {
      const hasActiveUiClients = hasActiveWsClientSessions();
      const providerSessions = Option.isSome(providerServiceOption)
        ? yield* providerServiceOption.value.listSessions()
        : [];
      const busyProviderSessionCount = providerSessions.reduce(
        (count, session) => count + (isProviderSessionBusy(session) ? 1 : 0),
        0,
      );
      return {
        hasActiveUiClients,
        providerSessionCount: providerSessions.length,
        busyProviderSessionCount,
        idle: !hasActiveUiClients && busyProviderSessionCount === 0,
      } satisfies MaintenanceIdleSnapshot;
    });

  const pickDueJob = (input: {
    readonly nowMs: number;
    readonly idle: boolean;
    readonly deepIdle: boolean;
  }): MaintenanceJob | undefined => {
    const dueJobs = jobs
      .filter((job) => job.nextRunAtMs <= input.nowMs)
      .toSorted((left, right) => {
        const leftPriority = phasePriority[left.phase];
        const rightPriority = phasePriority[right.phase];
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return left.nextRunAtMs - right.nextRunAtMs;
      });

    return dueJobs.find((job) => {
      if (job.phase === "always") return true;
      if (job.phase === "idle") return input.idle;
      return input.deepIdle;
    });
  };

  let idleStartedAtMs: number | null = null;
  const runMaintenanceTick = Effect.gen(function* () {
    const nowMs = Date.now();
    pruneWsClientSessionsIfNeeded(nowMs);

    const idleSnapshot = yield* readIdleSnapshot();
    if (idleSnapshot.idle) {
      idleStartedAtMs = idleStartedAtMs ?? nowMs;
    } else {
      idleStartedAtMs = null;
    }

    const idleDurationMs = idleStartedAtMs === null ? 0 : nowMs - idleStartedAtMs;
    const inIdleWindow = idleSnapshot.idle && idleDurationMs >= maintenanceIdleMinAgeMs;
    const inDeepIdleWindow = inIdleWindow && idleDurationMs >= maintenanceDeepIdleMinAgeMs;

    const dueJob = pickDueJob({
      nowMs,
      idle: inIdleWindow,
      deepIdle: inDeepIdleWindow,
    });
    if (!dueJob) {
      return;
    }

    const runResult = yield* dueJob
      .run({
        nowMs,
        sql: Option.getOrUndefined(sqlOption),
        readIdleSnapshot,
      })
      .pipe(Effect.timeoutOption(dueJob.timeoutMs));

    if (Option.isNone(runResult)) {
      scheduleNextRun(dueJob, nowMs);
      yield* Effect.logWarning("maintenance job timed out", {
        job: dueJob.id,
        phase: dueJob.phase,
        timeoutMs: dueJob.timeoutMs,
      });
      return;
    }

    if (runResult.value === "deferred") {
      return;
    }

    scheduleNextRun(dueJob, nowMs);
  });

  yield* withStartupTiming(
    "maintenance",
    "Starting maintenance scheduler",
    Effect.forkScoped(
      runMaintenanceTick.pipe(
        Effect.flatMap(() =>
          Effect.forever(
            Effect.sleep(`${maintenanceTickMs} millis`).pipe(
              Effect.flatMap(() => runMaintenanceTick),
            ),
          ),
        ),
      ),
    ),
    {
      endDetail: () => ({
        tickMs: maintenanceTickMs,
        jobCount: jobs.length,
      }),
    },
  );
});

export const MaintenanceRuntimeLive = Layer.effectDiscard(makeMaintenanceRuntime);
