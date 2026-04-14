import * as Net from "node:net";

import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";

import { RuntimeMode } from "./config";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const AceServerDaemonState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  mode: RuntimeMode,
  host: Schema.NullOr(Schema.String),
  port: PortSchema,
  wsUrl: Schema.String,
  authToken: Schema.String,
  baseDir: Schema.String,
  dbPath: Schema.String,
  serverLogPath: Schema.String,
  startedAt: Schema.String,
  updatedAt: Schema.String,
});
export type AceServerDaemonState = typeof AceServerDaemonState.Type;

export class DaemonStateError extends Data.TaggedError("DaemonStateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const decodeDaemonState = Schema.decodeUnknownSync(AceServerDaemonState);

export const resolveDaemonDirectory = Effect.fn("resolveDaemonDirectory")(function* (
  baseDir: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  return path.join(baseDir, "daemon");
});

export const resolveDaemonStatePath = Effect.fn("resolveDaemonStatePath")(function* (
  baseDir: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  return path.join(yield* resolveDaemonDirectory(baseDir), "server-state.json");
});

export const readDaemonState = Effect.fn("readDaemonState")(function* (
  baseDir: string,
): Effect.fn.Return<
  Option.Option<AceServerDaemonState>,
  DaemonStateError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* resolveDaemonStatePath(baseDir);
  const exists = yield* fs.exists(statePath).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonStateError({
          message: "Failed to check daemon state file existence.",
          cause,
        }),
    ),
  );

  if (!exists) {
    return Option.none<AceServerDaemonState>();
  }

  const raw = yield* fs.readFileString(statePath).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonStateError({
          message: "Failed to read daemon state file.",
          cause,
        }),
    ),
  );

  return yield* Effect.try<Option.Option<AceServerDaemonState>, DaemonStateError>({
    try: () => Option.some(decodeDaemonState(JSON.parse(raw))),
    catch: (cause) =>
      new DaemonStateError({
        message: "Failed to parse daemon state JSON.",
        cause,
      }),
  });
});

export const writeDaemonState = Effect.fn("writeDaemonState")(function* (
  state: AceServerDaemonState,
): Effect.fn.Return<void, DaemonStateError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const daemonDirectory = yield* resolveDaemonDirectory(state.baseDir);
  const statePath = yield* resolveDaemonStatePath(state.baseDir);

  yield* fs.makeDirectory(daemonDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonStateError({
          message: "Failed to create daemon state directory.",
          cause,
        }),
    ),
  );
  yield* fs.writeFileString(statePath, `${JSON.stringify(state, null, 2)}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonStateError({
          message: "Failed to write daemon state file.",
          cause,
        }),
    ),
  );
});

export const clearDaemonState = Effect.fn("clearDaemonState")(function* (
  baseDir: string,
): Effect.fn.Return<void, DaemonStateError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* resolveDaemonStatePath(baseDir);
  const exists = yield* fs.exists(statePath).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonStateError({
          message: "Failed to check daemon state file existence.",
          cause,
        }),
    ),
  );
  if (!exists) {
    return;
  }

  yield* fs.remove(statePath).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonStateError({
          message: "Failed to clear daemon state file.",
          cause,
        }),
    ),
  );
});

const resolveProbeHost = (host: string | null): string => {
  if (!host || host.length === 0 || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
};

const canReachTcpEndpoint = ({
  host,
  port,
  timeoutMs,
}: {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Effect.Effect<boolean> =>
  Effect.promise<boolean>(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = new Net.Socket();
        let settled = false;

        const settle = (value: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          resolve(value);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => settle(true));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
        socket.connect(port, host);
      }),
  );

export const isProcessAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        (cause as { readonly code?: unknown }).code === "EPERM"
      ) {
        return true;
      }
      return false;
    }
  });

export interface DaemonProbeStatus {
  readonly processAlive: boolean;
  readonly tcpReachable: boolean;
  readonly healthy: boolean;
}

export const probeDaemonState = Effect.fn("probeDaemonState")(function* (
  state: AceServerDaemonState,
  options?: {
    readonly timeoutMs?: number;
  },
): Effect.fn.Return<DaemonProbeStatus> {
  const timeoutMs = Math.max(100, options?.timeoutMs ?? 600);
  const processAlive = yield* isProcessAlive(state.pid);
  if (!processAlive) {
    return {
      processAlive: false,
      tcpReachable: false,
      healthy: false,
    } satisfies DaemonProbeStatus;
  }

  const tcpReachable = yield* canReachTcpEndpoint({
    host: resolveProbeHost(state.host),
    port: state.port,
    timeoutMs,
  });
  return {
    processAlive,
    tcpReachable,
    healthy: processAlive && tcpReachable,
  } satisfies DaemonProbeStatus;
});

export const waitForDaemonReady = Effect.fn("waitForDaemonReady")(function* (
  state: AceServerDaemonState,
  options?: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly probeTimeoutMs?: number;
  },
): Effect.fn.Return<boolean> {
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 8_000);
  const pollIntervalMs = Math.max(50, options?.pollIntervalMs ?? 150);
  const probeTimeoutMs = Math.max(100, options?.probeTimeoutMs ?? 500);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = yield* probeDaemonState(state, { timeoutMs: probeTimeoutMs });
    if (status.healthy) {
      return true;
    }
    yield* Effect.sleep(`${pollIntervalMs} millis`);
  }

  return false;
});

export const waitForProcessExit = Effect.fn("waitForProcessExit")(function* (
  pid: number,
  options?: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
  },
): Effect.fn.Return<boolean> {
  const timeoutMs = Math.max(250, options?.timeoutMs ?? 5_000);
  const pollIntervalMs = Math.max(25, options?.pollIntervalMs ?? 100);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const alive = yield* isProcessAlive(pid);
    if (!alive) {
      return true;
    }
    yield* Effect.sleep(`${pollIntervalMs} millis`);
  }

  return !(yield* isProcessAlive(pid));
});
