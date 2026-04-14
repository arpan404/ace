import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Os from "node:os";
import * as Readline from "node:readline/promises";

import pc from "picocolors";
import { WS_METHODS, type ServerRuntimeProfile } from "@ace/contracts";
import { normalizeWsUrl } from "@ace/shared/hostConnections";
import { NetService } from "@ace/shared/Net";
import { createWsRpcProtocolLayer, makeWsRpcProtocolClient } from "@ace/shared/wsRpcProtocol";
import {
  addCliProject,
  listCliProjects,
  removeCliProject,
  type CliProjectSummary,
  CliProjectServicesLive,
} from "./cliProjects";
import {
  addCliRemoteConnection,
  listCliRemoteConnections,
  removeCliRemoteConnection,
  type CliRemoteConnectionSummary,
  CliRemoteConnectionServicesLive,
} from "./cliRemoteConnections";
import { normalizeCliWorkspaceRoot } from "./cliPaths";
import {
  type AceServerDaemonState,
  clearDaemonState,
  probeDaemonState,
  readDaemonState,
  waitForDaemonReady,
  waitForProcessExit,
  writeDaemonState,
} from "./daemon";
import {
  Config,
  Data,
  Effect,
  Exit,
  LogLevel,
  ManagedRuntime,
  Option,
  Schema,
  Scope,
} from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  type ServerConfigShape,
  RuntimeMode,
} from "./config";
import { readBootstrapEnvelope } from "./bootstrap";
import { resolveBaseDir } from "./os-jank";
import {
  buildProcessTree,
  deriveCpuPercentsFromCpuSeconds,
  sampleProcessTable,
  type ProcessProfileSample,
} from "./processProfile";
import { version as serverPackageVersion } from "../package.json" with { type: "json" };

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const DEFAULT_DAEMON_RESTART_TIMEOUT_MS = 8_000;
const DEFAULT_PROFILE_INTERVAL_MS = 1_000;
const PROFILE_RUNTIME_RPC_CONNECT_TIMEOUT_MS = 1_500;
const PROFILE_RUNTIME_RPC_READ_TIMEOUT_MS = 1_000;
const PROFILE_DASHBOARD_MAX_ROWS = 14;
const PROFILE_RENDER_DECIMALS = 1;

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  aceHome: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  authToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` binds to LAN interfaces unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to ACE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to ACE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("ACE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  mode: Config.schema(RuntimeMode, "ACE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("ACE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("ACE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  aceHome: Config.string("ACE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("ACE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  authToken: Config.string("ACE_AUTH_TOKEN").pipe(Config.option, Config.map(Option.getOrUndefined)),
  bootstrapFd: Config.int("ACE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("ACE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("ACE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

interface CliDataFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
}

class DaemonCommandError extends Data.TaggedError("DaemonCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  launchWorkspaceRoot: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const env = yield* EnvServerConfig;
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        flags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.mode)),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        flags.port,
        Option.fromUndefinedOr(env.port),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.port)),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () =>
          mode === "desktop" ? Effect.succeed(DEFAULT_PORT) : findAvailablePort(DEFAULT_PORT),
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        flags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.devUrl)),
      ),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          flags.baseDir,
          Option.fromUndefinedOr(env.aceHome),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.aceHome),
          ),
        ),
      ),
    );
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const noBrowser = resolveBooleanFlag(
      flags.noBrowser,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.noBrowser),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.noBrowser),
          ),
        ),
        () => mode === "desktop",
      ),
    );
    const authToken = Option.getOrUndefined(
      resolveOptionPrecedence(
        flags.authToken,
        Option.fromUndefinedOr(env.authToken),
        Option.flatMap(bootstrapEnvelope, (bootstrap) =>
          Option.fromUndefinedOr(bootstrap.authToken),
        ),
      ),
    );
    const autoBootstrapProjectFromCwd = resolveBooleanFlag(
      flags.autoBootstrapProjectFromCwd,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
          ),
        ),
        () => mode === "web",
      ),
    );
    const logWebSocketEvents = resolveBooleanFlag(
      flags.logWebSocketEvents,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.logWebSocketEvents),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.logWebSocketEvents),
          ),
        ),
        () => Boolean(devUrl),
      ),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        flags.host,
        Option.fromUndefinedOr(env.host),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
      ),
      () => (mode === "desktop" ? "0.0.0.0" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);
    const cwd = yield* Option.match(launchWorkspaceRoot, {
      onNone: () => Effect.succeed(process.cwd()),
      onSome: normalizeCliWorkspaceRoot,
    });

    const config: ServerConfigShape = {
      logLevel,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      host,
      staticDir,
      devUrl,
      noBrowser,
      authToken,
      autoBootstrapProjectFromCwd:
        Option.isSome(flags.autoBootstrapProjectFromCwd) ||
        env.autoBootstrapProjectFromCwd !== undefined ||
        Option.isSome(
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
          ),
        )
          ? autoBootstrapProjectFromCwd
          : Option.isSome(launchWorkspaceRoot),
      logWebSocketEvents,
    };

    return config;
  });

const resolveDataConfig = (flags: CliDataFlags, cliLogLevel: Option.Option<LogLevel.LogLevel>) =>
  Effect.gen(function* () {
    const env = yield* EnvServerConfig;
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(flags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(flags.baseDir, Option.fromUndefinedOr(env.aceHome)),
      ),
    );
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);

    return {
      logLevel: Option.getOrElse(cliLogLevel, () => env.logLevel),
      mode: "web",
      port: DEFAULT_PORT,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
    } satisfies ServerConfigShape;
  });

const serveCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const dataCommandFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

const profileIntervalMsFlag = Flag.integer("interval-ms").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(250))),
  Flag.withDescription("Dashboard refresh interval in milliseconds."),
  Flag.withDefault(DEFAULT_PROFILE_INTERVAL_MS),
);

const profilePidFlag = Flag.integer("pid").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  Flag.withDescription("Profile a specific process pid instead of the ace daemon pid."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print structured JSON output."),
  Flag.withDefault(false),
);

const openWorkspaceArgument = Argument.string("workspace").pipe(
  Argument.withDescription("Workspace path to bootstrap on launch."),
  Argument.optional,
);

const writeStdout = (output: string) =>
  Effect.sync(() => {
    process.stdout.write(output);
  });

const writeJson = (value: unknown) => writeStdout(`${JSON.stringify(value, null, 2)}\n`);

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);

const formatRows = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
  if (rows.length === 0) {
    return "";
  }
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (columns: ReadonlyArray<string>) =>
    columns.map((column, index) => column.padEnd(widths[index]!)).join("  ");
  return `${pc.bold(formatRow(headers))}\n${rows.map(formatRow).join("\n")}\n`;
};

const formatProjectRows = (projects: ReadonlyArray<CliProjectSummary>): string => {
  if (projects.length === 0) {
    return `${pc.dim("No projects added yet.")}\n`;
  }
  const headers = ["ID", "THREADS", "TITLE", "PATH"] as const;
  const rows = projects.map((project) => [
    project.id,
    String(project.activeThreadCount),
    project.title,
    project.workspaceRoot,
  ]);
  return formatRows(headers, rows);
};

const maskToken = (token: string): string => {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return "-";
  }
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***`;
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
};

const formatRemoteConnectionRows = (
  connections: ReadonlyArray<CliRemoteConnectionSummary>,
): string => {
  if (connections.length === 0) {
    return `${pc.dim("No remote connections saved yet.")}\n`;
  }
  const headers = ["ID", "NAME", "WS URL", "TOKEN", "UPDATED"] as const;
  const rows = connections.map((connection) => [
    connection.id,
    connection.name,
    connection.wsUrl,
    maskToken(connection.authToken),
    connection.updatedAt,
  ]);
  return formatRows(headers, rows);
};

interface RuntimeProfileWsClient {
  readonly readSnapshot: () => Promise<ServerRuntimeProfile>;
  readonly close: () => Promise<void>;
}

function withPromiseTimeout<T>(input: {
  readonly timeoutMs: number;
  readonly operationLabel: string;
  readonly operation: () => Promise<T>;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(
            `${input.operationLabel} timed out after ${String(Math.max(1, input.timeoutMs))}ms.`,
          ),
        );
      },
      Math.max(1, input.timeoutMs),
    );

    input
      .operation()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function createRuntimeProfileWsClient(wsUrl: string): Promise<RuntimeProfileWsClient> {
  const runtime = ManagedRuntime.make(createWsRpcProtocolLayer({ target: normalizeWsUrl(wsUrl) }));
  const scope = runtime.runSync(Scope.make());
  try {
    const client = await withPromiseTimeout({
      timeoutMs: PROFILE_RUNTIME_RPC_CONNECT_TIMEOUT_MS,
      operationLabel: "Connecting to daemon runtime profile RPC",
      operation: () => runtime.runPromise(Scope.provide(scope)(makeWsRpcProtocolClient)),
    });
    return {
      readSnapshot: () =>
        withPromiseTimeout({
          timeoutMs: PROFILE_RUNTIME_RPC_READ_TIMEOUT_MS,
          operationLabel: "Reading daemon runtime profile snapshot",
          operation: () => runtime.runPromise(client[WS_METHODS.serverGetRuntimeProfile]({})),
        }),
      close: async () => {
        try {
          await runtime.runPromise(Scope.close(scope, Exit.void));
        } finally {
          runtime.dispose();
        }
      },
    };
  } catch (error) {
    try {
      await runtime.runPromise(Scope.close(scope, Exit.void));
    } finally {
      runtime.dispose();
    }
    throw error;
  }
}

function formatByteCount(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : PROFILE_RENDER_DECIMALS;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatCpuPercent(cpuPercent: number | null): string {
  if (cpuPercent === null || !Number.isFinite(cpuPercent)) {
    return "-";
  }
  return `${cpuPercent.toFixed(PROFILE_RENDER_DECIMALS)}%`;
}

function formatUptimeSeconds(uptimeSeconds: number): string {
  const total = Math.max(0, Math.floor(uptimeSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  }
  if (minutes > 0) {
    return `${String(minutes)}m ${String(seconds)}s`;
  }
  return `${String(seconds)}s`;
}

function formatProcessCommand(sample: ProcessProfileSample, maxLength = 84): string {
  const raw = sample.command.trim().length > 0 ? sample.command.trim() : sample.executable;
  if (raw.length <= maxLength) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildProfileProcessRows(input: {
  readonly targetPid: number;
  readonly samples: ReadonlyArray<ProcessProfileSample>;
}): ReadonlyArray<ReadonlyArray<string>> {
  return input.samples
    .slice(0, PROFILE_DASHBOARD_MAX_ROWS)
    .map((sample) => [
      sample.pid === input.targetPid ? `*${String(sample.pid)}` : String(sample.pid),
      String(sample.ppid),
      formatByteCount(sample.rssBytes),
      formatCpuPercent(sample.cpuPercent),
      formatProcessCommand(sample),
    ]);
}

function formatProviderSessionCounts(snapshot: ServerRuntimeProfile | null): string {
  if (!snapshot || snapshot.providerSessions.length === 0) {
    return "-";
  }
  return snapshot.providerSessions
    .map((entry) => `${entry.provider}:${String(entry.sessionCount)}`)
    .join("  ");
}

function renderProfileDashboard(input: {
  readonly targetPid: number;
  readonly intervalMs: number;
  readonly sampledAt: string;
  readonly processTree: {
    readonly processes: ReadonlyArray<ProcessProfileSample>;
    readonly totalRssBytes: number;
    readonly totalCpuPercent: number | null;
  };
  readonly runtimeProfile: ServerRuntimeProfile | null;
  readonly runtimeProfileError: string | null;
}): string {
  const rows = buildProfileProcessRows({
    targetPid: input.targetPid,
    samples: input.processTree.processes,
  });
  const processTable = formatRows(["PID", "PPID", "RSS", "CPU", "COMMAND"], rows);
  const runtimeProfile = input.runtimeProfile;
  const processMemoryLine = runtimeProfile
    ? `Process memory: rss ${formatByteCount(runtimeProfile.process.rssBytes)} | heap ${formatByteCount(
        runtimeProfile.process.heapUsedBytes,
      )}/${formatByteCount(runtimeProfile.process.heapTotalBytes)} | external ${formatByteCount(
        runtimeProfile.process.externalBytes,
      )} | arrayBuffers ${formatByteCount(runtimeProfile.process.arrayBuffersBytes)}`
    : "Process memory: unavailable";
  const cacheLine = runtimeProfile
    ? `Caches: snapshot-view ${String(runtimeProfile.caches.snapshotView.currentEntries)}/${String(
        runtimeProfile.caches.snapshotView.maxEntries,
      )} | assistant-streams ${String(
        runtimeProfile.caches.providerRuntimeIngestion.activeAssistantStreams,
      )} | pending-deltas ${String(
        runtimeProfile.caches.providerRuntimeIngestion.pendingAssistantDeltaStreams,
      )} | thinking ${String(runtimeProfile.caches.providerRuntimeIngestion.bufferedThinkingActivities)}`
    : "Caches: unavailable";
  const runtimeLine = runtimeProfile
    ? `Runtime: ${runtimeProfile.process.platform} ${runtimeProfile.process.nodeVersion} | uptime ${formatUptimeSeconds(
        runtimeProfile.process.uptimeSeconds,
      )}`
    : "Runtime: unavailable";
  const errorLine =
    input.runtimeProfileError === null
      ? ""
      : `\n${pc.yellow(`Runtime profile unavailable: ${input.runtimeProfileError}`)}`;

  return [
    `ace profile ${pc.dim(`(refresh ${String(input.intervalMs)}ms)`)} | sampled ${input.sampledAt}`,
    `Target pid: ${String(input.targetPid)} | Processes: ${String(input.processTree.processes.length)} | Total rss: ${formatByteCount(input.processTree.totalRssBytes)} | Total cpu: ${formatCpuPercent(input.processTree.totalCpuPercent)}`,
    processMemoryLine,
    cacheLine,
    `Provider sessions: ${formatProviderSessionCounts(runtimeProfile)}`,
    runtimeLine,
    "",
    processTable.trimEnd(),
    errorLine,
    "",
    pc.dim("Press Ctrl+C to stop."),
  ].join("\n");
}

function clearTerminalViewport(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write("\x1b[2J\x1b[H");
}

const runCliProjectCommand = <A, E, R>(flags: CliDataFlags, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveDataConfig(flags, logLevel);
    return yield* effect.pipe(
      Effect.provide(CliProjectServicesLive),
      Effect.provideService(ServerConfig, config),
    );
  });

const runCliRemoteConnectionCommand = <A, E, R>(
  flags: CliDataFlags,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveDataConfig(flags, logLevel);
    return yield* effect.pipe(
      Effect.provide(CliRemoteConnectionServicesLive),
      Effect.provideService(ServerConfig, config),
    );
  });

const runDaemonCommand = <A, E, R>(flags: CliDataFlags, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveDataConfig(flags, logLevel);
    return yield* effect.pipe(Effect.provideService(ServerConfig, config));
  });

export const applyDaemonRestartStateDefaults = (
  flags: CliServerFlags,
  existingState: AceServerDaemonState | null,
): CliServerFlags => ({
  ...flags,
  mode: Option.isSome(flags.mode) || !existingState ? flags.mode : Option.some(existingState.mode),
  port: Option.isSome(flags.port) || !existingState ? flags.port : Option.some(existingState.port),
  host:
    Option.isSome(flags.host) || !existingState || existingState.host === null
      ? flags.host
      : Option.some(existingState.host),
  authToken:
    Option.isSome(flags.authToken) || !existingState
      ? flags.authToken
      : Option.some(existingState.authToken),
});

export const isDaemonStateCurrentVersion = (
  state: AceServerDaemonState | null,
  currentVersion = serverPackageVersion,
): boolean => {
  if (!state) {
    return false;
  }
  return state.serverVersion === currentVersion;
};

interface DaemonStatusPayload {
  readonly status: "running" | "stopped" | "stale";
  readonly state: AceServerDaemonState | null;
  readonly processAlive: boolean;
  readonly tcpReachable: boolean;
}

const readDaemonStatusPayload = Effect.fn("readDaemonStatusPayload")(function* (baseDir: string) {
  const stateOption = yield* readDaemonState(baseDir);
  if (Option.isNone(stateOption)) {
    return {
      status: "stopped",
      state: null,
      processAlive: false,
      tcpReachable: false,
    } satisfies DaemonStatusPayload;
  }

  const probe = yield* probeDaemonState(stateOption.value);
  return {
    status: probe.healthy ? "running" : ("stale" as const),
    state: stateOption.value,
    processAlive: probe.processAlive,
    tcpReachable: probe.tcpReachable,
  } satisfies DaemonStatusPayload;
});

const formatDaemonStatus = (status: DaemonStatusPayload): string => {
  if (status.status === "stopped") {
    return `${pc.yellow("●")} Daemon not running\n`;
  }
  if (!status.state) {
    return `${pc.yellow("●")} Daemon state unavailable\n`;
  }
  const health = status.status === "running" ? pc.green("running") : pc.yellow("stale");
  const lines = [
    `${pc.cyan("Daemon")}: ${health}`,
    `PID: ${String(status.state.pid)}`,
    `Mode: ${status.state.mode}`,
    `Port: ${String(status.state.port)}`,
    `Host: ${status.state.host ?? "(default)"}`,
    `WS URL: ${status.state.wsUrl}`,
    `DB: ${status.state.dbPath}`,
    `Logs: ${status.state.serverLogPath}`,
  ];
  return `${lines.join("\n")}\n`;
};

interface ProfileTarget {
  readonly pid: number;
  readonly daemonState: AceServerDaemonState | null;
}

const resolveProfileTarget = Effect.fn("resolveProfileTarget")(function* (input: {
  readonly baseDir: string;
  readonly pid: Option.Option<number>;
}) {
  const daemonStatus = yield* readDaemonStatusPayload(input.baseDir);
  if (Option.isSome(input.pid)) {
    const selectedPid = input.pid.value;
    const daemonState =
      daemonStatus.state && daemonStatus.state.pid === selectedPid && daemonStatus.processAlive
        ? daemonStatus.state
        : null;
    return {
      pid: selectedPid,
      daemonState,
    } satisfies ProfileTarget;
  }

  if (!daemonStatus.state || !daemonStatus.processAlive) {
    return yield* new DaemonCommandError({
      message:
        "No running ace daemon found. Start one with `ace daemon start` or pass `--pid <pid>`.",
    });
  }
  return {
    pid: daemonStatus.state.pid,
    daemonState: daemonStatus.state,
  } satisfies ProfileTarget;
});

const resolveDaemonEntry = Effect.gen(function* () {
  const entryPath = process.argv[1]?.trim();
  if (!entryPath) {
    return yield* new DaemonCommandError({
      message: "Could not resolve CLI entry path for daemon process launch.",
    });
  }
  return entryPath;
});

const normalizeDaemonWsHost = (host: string | null): string => {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
};

const buildDaemonWsUrl = (host: string | null, port: number, authToken: string): string =>
  `ws://${normalizeDaemonWsHost(host)}:${port}/?token=${encodeURIComponent(authToken)}`;

const isErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === code;

const sendSignal = (pid: number, signal: NodeJS.Signals) =>
  Effect.try({
    try: () => process.kill(pid, signal),
    catch: (cause) =>
      new DaemonCommandError({
        message: `Failed to signal daemon process ${String(pid)} with ${signal}.`,
        cause,
      }),
  }).pipe(
    Effect.catchIf(
      (error) => isErrnoCode(error.cause, "ESRCH"),
      () => Effect.void,
    ),
  );

const spawnDaemonServer = Effect.fn("spawnDaemonServer")(function* (input: {
  readonly config: ServerConfigShape;
  readonly authToken: string;
}) {
  const entryPath = yield* resolveDaemonEntry;
  const daemonArgs = [
    entryPath,
    "--log-level",
    input.config.logLevel.toLowerCase(),
    "serve",
    "--mode",
    input.config.mode,
    "--port",
    String(input.config.port),
    "--base-dir",
    input.config.baseDir,
    "--no-browser",
    "--auth-token",
    input.authToken,
  ];
  if (input.config.host) {
    daemonArgs.push("--host", input.config.host);
  }
  if (input.config.devUrl) {
    daemonArgs.push("--dev-url", input.config.devUrl.toString());
  }
  if (input.config.autoBootstrapProjectFromCwd) {
    daemonArgs.push("--auto-bootstrap-project-from-cwd");
  }
  if (input.config.logWebSocketEvents) {
    daemonArgs.push("--log-websocket-events");
  }

  const child = yield* Effect.try({
    try: () =>
      ChildProcess.spawn(process.execPath, daemonArgs, {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ACE_DAEMONIZED: "1",
        },
        windowsHide: true,
      }),
    catch: (cause) =>
      new DaemonCommandError({
        message: "Failed to spawn daemon server process.",
        cause,
      }),
  });
  child.unref();
  if (!child.pid || child.pid <= 0) {
    return yield* new DaemonCommandError({
      message: "Daemon server process did not expose a valid pid.",
    });
  }
  return child.pid;
});

const stopDaemonIfPresent = Effect.fn("stopDaemonIfPresent")(function* (input: {
  readonly baseDir: string;
  readonly timeoutMs: number;
}) {
  const status = yield* readDaemonStatusPayload(input.baseDir);
  if (!status.state) {
    return {
      status: "already-stopped" as const,
    };
  }

  if (!status.processAlive) {
    yield* clearDaemonState(input.baseDir);
    return {
      status: "cleared-stale-state" as const,
    };
  }

  yield* sendSignal(status.state.pid, "SIGTERM");
  const exited = yield* waitForProcessExit(status.state.pid, { timeoutMs: input.timeoutMs });
  if (!exited) {
    yield* sendSignal(status.state.pid, "SIGKILL");
    const forcedExit = yield* waitForProcessExit(status.state.pid, { timeoutMs: 2_000 });
    if (!forcedExit) {
      return yield* new DaemonCommandError({
        message: `Daemon process ${String(status.state.pid)} did not exit after SIGKILL.`,
      });
    }
  }
  yield* clearDaemonState(input.baseDir);

  return {
    status: "stopped" as const,
    pid: status.state.pid,
  };
});

const startDaemonAndPersistState = Effect.fn("startDaemonAndPersistState")(function* (input: {
  readonly config: ServerConfigShape;
}) {
  const authToken = input.config.authToken ?? Crypto.randomBytes(24).toString("hex");
  const pid = yield* spawnDaemonServer({
    config: input.config,
    authToken,
  });
  const now = new Date().toISOString();
  const state: AceServerDaemonState = {
    version: 1,
    pid,
    serverVersion: serverPackageVersion,
    mode: input.config.mode,
    host: input.config.host ?? null,
    port: input.config.port,
    wsUrl: buildDaemonWsUrl(input.config.host ?? null, input.config.port, authToken),
    authToken,
    baseDir: input.config.baseDir,
    dbPath: input.config.dbPath,
    serverLogPath: input.config.serverLogPath,
    startedAt: now,
    updatedAt: now,
  };
  yield* writeDaemonState(state);

  const ready = yield* waitForDaemonReady(state, {
    timeoutMs: 10_000,
  });
  if (!ready) {
    yield* clearDaemonState(input.config.baseDir);
    return yield* new DaemonCommandError({
      message: "Daemon process did not become reachable before timeout.",
    });
  }

  return state;
});

const streamDaemonLogs = (logPath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs"));
    const rl = Readline.createInterface({
      input: fs.createReadStream(logPath),
      crlfDelay: Infinity,
    });

    const promise = new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        process.stdout.write(line + "\n");
      });
      rl.on("close", () => resolve());
      rl.on("error", (err) => {
        process.stderr.write(`Log stream error: ${err.message}\n`);
        resolve();
      });
    });

    return yield* Effect.promise(() => promise);
  });

const serveCommand = Command.make("serve", {
  ...serveCommandFlags,
  workspaceRoot: openWorkspaceArgument,
}).pipe(
  Command.withDescription("Run the ace HTTP/WebSocket server."),
  Command.withHandler(({ workspaceRoot, ...flags }) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, workspaceRoot);
      const baseDir = config.baseDir;

      const existingState = yield* readDaemonState(baseDir);

      if (Option.isSome(existingState)) {
        const probe = yield* probeDaemonState(existingState.value);
        if (probe.healthy) {
          yield* writeStdout(`${pc.green("Connecting to existing daemon...")}\n`);
          return yield* streamDaemonLogs(existingState.value.serverLogPath);
        }
      }

      yield* writeStdout(`${pc.yellow("No daemon found, starting one...")}\n`);
      const state = yield* startDaemonAndPersistState({ config });
      yield* writeStdout(`${pc.green("Daemon started")} pid=${String(state.pid)} ${state.wsUrl}\n`);
      return yield* streamDaemonLogs(state.serverLogPath);
    }),
  ),
);

const projectAddCommand = Command.make("add", {
  ...dataCommandFlags,
  path: Argument.string("path").pipe(Argument.withDescription("Workspace directory path to add.")),
  title: Flag.string("title").pipe(
    Flag.withDescription("Optional project title override."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a workspace project to ace."),
  Command.withHandler(({ path, title, json, ...flags }) =>
    Effect.gen(function* () {
      const result = yield* runCliProjectCommand(
        flags,
        addCliProject({
          workspaceRoot: path,
          ...(Option.isSome(title) ? { title: title.value } : {}),
        }),
      );
      if (json) {
        return yield* writeJson(result);
      }

      const verb = result.status === "created" ? pc.green("Added") : pc.yellow("Already added");
      return yield* writeStdout(
        `${verb} project "${result.project.title}" (${result.project.workspaceRoot}) [${result.project.id}]\n`,
      );
    }),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...dataCommandFlags,
  selector: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace path."),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Delete all project threads before removing the project."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withAlias("delete"),
  Command.withDescription("Remove a project from ace."),
  Command.withHandler(({ selector, force, json, ...flags }) =>
    Effect.gen(function* () {
      const result = yield* runCliProjectCommand(
        flags,
        removeCliProject({
          selector,
          force,
        }),
      );
      if (json) {
        return yield* writeJson(result);
      }

      const threadSuffix =
        result.deletedThreadCount > 0
          ? ` and deleted ${result.deletedThreadCount} thread${result.deletedThreadCount === 1 ? "" : "s"}`
          : "";
      return yield* writeStdout(
        `${pc.green("Removed")} project "${result.project.title}" (${result.project.workspaceRoot})${threadSuffix}.\n`,
      );
    }),
  ),
);

const projectListCommand = Command.make("list", {
  ...dataCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List projects stored in ace."),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      const projects = yield* runCliProjectCommand(flags, listCliProjects);
      if (json) {
        return yield* writeJson(projects);
      }
      return yield* writeStdout(formatProjectRows(projects));
    }),
  ),
);

const projectCommand = Command.make("project").pipe(
  Command.withAlias("projects"),
  Command.withDescription("Manage stored projects without launching the server runtime."),
  Command.withSubcommands([projectAddCommand, projectRemoveCommand, projectListCommand]),
);

const remoteAddCommand = Command.make("add", {
  ...dataCommandFlags,
  wsUrl: Argument.string("ws-url").pipe(
    Argument.withDescription("Remote host ws/http URL (token can be embedded with ?token=...)."),
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Optional display name override."),
    Flag.optional,
  ),
  authToken: Flag.string("auth-token").pipe(
    Flag.withAlias("token"),
    Flag.withDescription("Optional auth token override."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add or update a saved remote connection."),
  Command.withHandler(({ wsUrl, name, authToken, json, ...flags }) =>
    Effect.gen(function* () {
      const result = yield* runCliRemoteConnectionCommand(
        flags,
        addCliRemoteConnection({
          wsUrl,
          ...(Option.isSome(name) ? { name: name.value } : {}),
          ...(Option.isSome(authToken) ? { authToken: authToken.value } : {}),
        }),
      );
      if (json) {
        return yield* writeJson(result);
      }
      const verb = result.status === "created" ? pc.green("Added") : pc.yellow("Updated");
      return yield* writeStdout(
        `${verb} remote "${result.connection.name}" (${result.connection.wsUrl}) [${result.connection.id}]\n`,
      );
    }),
  ),
);

const remoteRemoveCommand = Command.make("remove", {
  ...dataCommandFlags,
  selector: Argument.string("remote").pipe(
    Argument.withDescription("Remote connection id, name, or ws url."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withAlias("delete"),
  Command.withDescription("Remove a saved remote connection."),
  Command.withHandler(({ selector, json, ...flags }) =>
    Effect.gen(function* () {
      const result = yield* runCliRemoteConnectionCommand(
        flags,
        removeCliRemoteConnection({ selector }),
      );
      if (json) {
        return yield* writeJson(result);
      }
      return yield* writeStdout(
        `${pc.green("Removed")} remote "${result.connection.name}" (${result.connection.wsUrl}).\n`,
      );
    }),
  ),
);

const remoteListCommand = Command.make("list", {
  ...dataCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List saved remote connections."),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      const remotes = yield* runCliRemoteConnectionCommand(flags, listCliRemoteConnections);
      if (json) {
        return yield* writeJson(remotes);
      }
      return yield* writeStdout(formatRemoteConnectionRows(remotes));
    }),
  ),
);

const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage saved remote host connections."),
  Command.withSubcommands([remoteAddCommand, remoteRemoveCommand, remoteListCommand]),
);

const daemonStartCommand = Command.make("start", {
  ...serveCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start the ace server daemon in the background (idempotent)."),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(
        {
          ...flags,
          noBrowser: Option.some(true),
        },
        logLevel,
      );

      const existingStatus = yield* readDaemonStatusPayload(config.baseDir);
      if (existingStatus.state && existingStatus.processAlive) {
        const eventuallyReady = yield* waitForDaemonReady(existingStatus.state, {
          timeoutMs: 3_000,
        });
        if (eventuallyReady) {
          if (isDaemonStateCurrentVersion(existingStatus.state)) {
            const payload = {
              status: "already-running" as const,
              daemon: existingStatus.state,
            };
            if (json) {
              return yield* writeJson(payload);
            }
            return yield* writeStdout(
              `${pc.yellow("Already running")} daemon pid=${String(existingStatus.state.pid)} ${existingStatus.state.wsUrl}\n`,
            );
          }

          const stopResult = yield* stopDaemonIfPresent({
            baseDir: config.baseDir,
            timeoutMs: DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
          });
          const state = yield* startDaemonAndPersistState({ config });
          const payload = {
            status: "started" as const,
            daemon: state,
            upgraded: true as const,
            previousVersion: existingStatus.state.serverVersion,
            stop: stopResult,
          };
          if (json) {
            return yield* writeJson(payload);
          }
          return yield* writeStdout(
            `${pc.green("Started")} daemon pid=${String(state.pid)} ${state.wsUrl} ${pc.dim(
              `(upgraded from ${existingStatus.state.serverVersion})`,
            )}\n`,
          );
        }
        return yield* new DaemonCommandError({
          message:
            "A daemon process appears to be running but is not healthy. Refusing to replace it automatically.",
        });
      }

      if (existingStatus.status === "stale") {
        yield* clearDaemonState(config.baseDir);
      }

      const state = yield* startDaemonAndPersistState({ config });

      const payload = {
        status: "started" as const,
        daemon: state,
      };
      if (json) {
        return yield* writeJson(payload);
      }

      return yield* writeStdout(
        `${pc.green("Started")} daemon pid=${String(state.pid)} ${state.wsUrl}\n`,
      );
    }),
  ),
);

const daemonRestartCommand = Command.make("restart", {
  ...serveCommandFlags,
  timeoutMs: Flag.integer("timeout-ms").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(250))),
    Flag.withDescription("How long to wait for graceful daemon shutdown."),
    Flag.withDefault(DEFAULT_DAEMON_RESTART_TIMEOUT_MS),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Restart the background daemon process."),
  Command.withHandler(({ timeoutMs, json, ...flags }) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const dataConfig = yield* resolveDataConfig(
        {
          baseDir: flags.baseDir,
          devUrl: flags.devUrl,
        },
        logLevel,
      );
      const existingStatus = yield* readDaemonStatusPayload(dataConfig.baseDir);
      const config = yield* resolveServerConfig(
        applyDaemonRestartStateDefaults(
          {
            ...flags,
            noBrowser: Option.some(true),
          },
          existingStatus.state,
        ),
        logLevel,
      );

      const stopResult = yield* stopDaemonIfPresent({
        baseDir: config.baseDir,
        timeoutMs,
      });
      const state = yield* startDaemonAndPersistState({ config });
      const payload = {
        status: "restarted" as const,
        daemon: state,
        stop: stopResult,
      };
      if (json) {
        return yield* writeJson(payload);
      }
      return yield* writeStdout(
        `${pc.green("Restarted")} daemon pid=${String(state.pid)} ${state.wsUrl}\n`,
      );
    }),
  ),
);

const daemonStatusCommand = Command.make("status", {
  ...dataCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read background daemon status."),
  Command.withHandler(({ json, ...flags }) =>
    runDaemonCommand(
      flags,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const status = yield* readDaemonStatusPayload(config.baseDir);
        if (json) {
          return yield* writeJson(status);
        }
        return yield* writeStdout(formatDaemonStatus(status));
      }),
    ),
  ),
);

const daemonStopCommand = Command.make("stop", {
  ...dataCommandFlags,
  timeoutMs: Flag.integer("timeout-ms").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(250))),
    Flag.withDescription("How long to wait for graceful daemon shutdown."),
    Flag.withDefault(8_000),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Stop the background daemon process."),
  Command.withHandler(({ timeoutMs, json, ...flags }) =>
    runDaemonCommand(
      flags,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const result = yield* stopDaemonIfPresent({
          baseDir: config.baseDir,
          timeoutMs,
        });
        if (json) {
          return yield* writeJson(result);
        }
        if (result.status === "already-stopped") {
          return yield* writeStdout(`${pc.yellow("Already stopped")} daemon not running\n`);
        }
        if (result.status === "cleared-stale-state") {
          return yield* writeStdout(`${pc.yellow("Cleared")} stale daemon state\n`);
        }
        return yield* writeStdout(`${pc.green("Stopped")} daemon pid=${String(result.pid)}\n`);
      }),
    ),
  ),
);

const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Manage the persistent background ace server."),
  Command.withSubcommands([
    daemonStartCommand,
    daemonStatusCommand,
    daemonStopCommand,
    daemonRestartCommand,
  ]),
);

const profileCommand = Command.make("profile", {
  ...dataCommandFlags,
  pid: profilePidFlag,
  intervalMs: profileIntervalMsFlag,
  json: jsonFlag,
}).pipe(
  Command.withAlias("p"),
  Command.withDescription(
    "Live process/resource profiler for ace daemon subprocesses and runtime memory/cache stats.",
  ),
  Command.withHandler(({ pid, intervalMs, json, ...flags }) =>
    runDaemonCommand(
      flags,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const target = yield* resolveProfileTarget({
          baseDir: config.baseDir,
          pid,
        });
        const cpuCoreCount = Math.max(1, Os.cpus().length);
        const runtimeProfileWsUrl = target.daemonState?.wsUrl;
        let runtimeProfileClient: RuntimeProfileWsClient | null = null;
        let runtimeProfileUnavailableReason: string | null =
          runtimeProfileWsUrl === undefined
            ? "Runtime profile RPC is unavailable for this profile target."
            : null;

        yield* Effect.addFinalizer(() => {
          const client = runtimeProfileClient;
          if (!client) {
            return Effect.void;
          }
          return Effect.promise(() =>
            client.close().catch(() => {
              // noop
            }),
          );
        });

        let previousCpuSecondsByPid = new Map<number, number>();
        let previousSampleAtMs = Date.now();
        for (;;) {
          const sampledAtMs = Date.now();
          const sampledAt = new Date(sampledAtMs).toISOString();
          const sampledProcesses = yield* Effect.tryPromise({
            try: () => sampleProcessTable(),
            catch: (cause) =>
              new DaemonCommandError({
                message: "Failed to sample operating-system process table for profiling.",
                cause,
              }),
          });
          const elapsedMs = Math.max(1, sampledAtMs - previousSampleAtMs);
          const cpuDerived = deriveCpuPercentsFromCpuSeconds({
            samples: sampledProcesses,
            previousCpuSecondsByPid,
            elapsedMs,
            cpuCoreCount,
          });
          previousCpuSecondsByPid = cpuDerived.nextCpuSecondsByPid;
          previousSampleAtMs = sampledAtMs;

          const processTree = buildProcessTree(cpuDerived.samples, target.pid);
          if (!processTree.found) {
            const message = `Profile target pid=${String(target.pid)} no longer exists.`;
            if (json) {
              return yield* writeJson({
                sampledAt,
                targetPid: target.pid,
                status: "terminated",
                message,
              });
            }
            return yield* writeStdout(`${pc.yellow(message)}\n`);
          }

          if (runtimeProfileClient === null && runtimeProfileWsUrl) {
            runtimeProfileClient = yield* Effect.tryPromise({
              try: () => createRuntimeProfileWsClient(runtimeProfileWsUrl),
              catch: (cause) =>
                new DaemonCommandError({
                  message: "Failed to connect to daemon runtime profile RPC endpoint.",
                  cause,
                }),
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  runtimeProfileUnavailableReason = formatErrorMessage(error);
                  return null as RuntimeProfileWsClient | null;
                }),
              ),
            );
          }

          let runtimeProfile: ServerRuntimeProfile | null = null;
          let runtimeProfileError: string | null = runtimeProfileUnavailableReason;
          if (runtimeProfileClient) {
            const currentRuntimeProfileClient = runtimeProfileClient;
            const profileSnapshot = yield* Effect.tryPromise({
              try: () => currentRuntimeProfileClient.readSnapshot(),
              catch: (cause) =>
                new DaemonCommandError({
                  message: "Failed to read daemon runtime profile snapshot.",
                  cause,
                }),
            }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  runtimeProfileUnavailableReason = formatErrorMessage(error);
                  runtimeProfileError = runtimeProfileUnavailableReason;
                  const clientToClose = runtimeProfileClient;
                  runtimeProfileClient = null;
                  if (clientToClose) {
                    yield* Effect.promise(() =>
                      clientToClose.close().catch(() => {
                        // noop
                      }),
                    );
                  }
                  return null as ServerRuntimeProfile | null;
                }),
              ),
            );
            runtimeProfile = profileSnapshot;
            if (profileSnapshot !== null) {
              runtimeProfileUnavailableReason = null;
              runtimeProfileError = null;
            }
          }

          if (json) {
            yield* writeStdout(
              `${JSON.stringify({
                sampledAt,
                targetPid: target.pid,
                processTree: {
                  processCount: processTree.processes.length,
                  totalRssBytes: processTree.totalRssBytes,
                  totalCpuPercent: processTree.totalCpuPercent,
                  processes: processTree.processes.slice(0, PROFILE_DASHBOARD_MAX_ROWS),
                },
                runtimeProfile,
                ...(runtimeProfileError ? { runtimeProfileError } : {}),
              })}\n`,
            );
            yield* Effect.sleep(`${intervalMs} millis`);
            continue;
          }

          clearTerminalViewport();
          yield* writeStdout(
            `${renderProfileDashboard({
              targetPid: target.pid,
              intervalMs,
              sampledAt,
              processTree,
              runtimeProfile,
              runtimeProfileError,
            })}\n`,
          );
          yield* Effect.sleep(`${intervalMs} millis`);
        }
      }),
    ),
  ),
);

const rootBannerLines = [
  " █████╗  ██████╗███████╗",
  "██╔══██╗██╔════╝██╔════╝",
  "███████║██║     █████╗  ",
  "██╔══██║██║     ██╔══╝  ",
  "██║  ██║╚██████╗███████╗",
  "╚═╝  ╚═╝ ╚═════╝╚══════╝",
] as const;

const BANNER_WIDTH = 26;

const centerBannerLine = (line: string): string => {
  const padding = BANNER_WIDTH - line.length;
  const leftPad = Math.floor(padding / 2);
  return " ".repeat(leftPad) + line;
};

const rootBannerPalette = [pc.white, pc.gray, pc.white, pc.gray, pc.white, pc.gray] as const;

const colorizeRootBannerLine = (line: string, index: number): string => {
  const color = rootBannerPalette[index % rootBannerPalette.length] ?? pc.cyan;
  const centered = centerBannerLine(line);
  return index % 2 === 0 ? pc.bold(color(centered)) : color(centered);
};

export const formatRootCliBanner = (): string =>
  `${rootBannerLines.map((line, index) => colorizeRootBannerLine(line, index)).join("\n")}\n`;

const formatRootCliGuide = (): string =>
  [
    `${pc.bold("ace CLI")}`,
    `${pc.bold("Quick start")}`,
    `  ${pc.cyan("ace serve")}              run server in foreground`,
    `  ${pc.cyan("ace --profile")}          live ace-specific process/memory profiler`,
    `  ${pc.cyan("ace daemon start")}       run reusable background daemon`,
    `  ${pc.cyan("ace --restart")}          restart background daemon`,
    `  ${pc.cyan("ace interactive")}        launch quick interactive command picker`,
    `  ${pc.cyan("ace project list")}       list saved local projects`,
    `  ${pc.cyan("ace remote list")}        list saved remote hosts`,
    `  ${pc.cyan("ace --help")}             show full command reference`,
  ].join("\n");

const shouldAnimateRootCliLogo = (): boolean =>
  process.stdout.isTTY &&
  process.env.CI !== "1" &&
  process.env.NO_COLOR === undefined &&
  process.env.ACE_CLI_DISABLE_ANIMATION !== "1";

export const playRootCliLogoAnimation = Effect.gen(function* () {
  if (!shouldAnimateRootCliLogo()) {
    return false;
  }

  yield* writeStdout("\x1b[?25l");
  try {
    for (const [index, line] of rootBannerLines.entries()) {
      yield* writeStdout(`${colorizeRootBannerLine(line, index)}\n`);
      yield* Effect.sleep("38 millis");
    }
  } finally {
    yield* writeStdout("\x1b[?25h");
  }

  return true;
});

const interactiveActionIds = [
  "serve",
  "daemon-status",
  "daemon-restart",
  "project-list",
  "remote-list",
] as const;
type InteractiveActionId = (typeof interactiveActionIds)[number];

const interactiveActions: Record<
  InteractiveActionId,
  { readonly description: string; readonly argv: ReadonlyArray<string> }
> = {
  serve: {
    description: "Run server in foreground",
    argv: ["serve"],
  },
  "daemon-status": {
    description: "Show daemon status",
    argv: ["daemon", "status"],
  },
  "daemon-restart": {
    description: "Restart daemon",
    argv: ["daemon", "restart"],
  },
  "project-list": {
    description: "List saved projects",
    argv: ["project", "list"],
  },
  "remote-list": {
    description: "List saved remote hosts",
    argv: ["remote", "list"],
  },
};

const promptInteractiveAction = Effect.tryPromise({
  try: async (): Promise<InteractiveActionId> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Interactive mode requires a TTY. Use `ace interactive --action <name>` in non-interactive environments.",
      );
    }

    const rl = Readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      process.stdout.write(`${pc.bold("Select an action")}\n`);
      interactiveActionIds.forEach((actionId, index) => {
        const action = interactiveActions[actionId];
        process.stdout.write(
          `  ${pc.cyan(String(index + 1))}. ${actionId} ${pc.dim(`- ${action.description}`)}\n`,
        );
      });
      const answer = (await rl.question(`${pc.magenta("›")} `)).trim().toLowerCase();
      const byIndex = Number.parseInt(answer, 10);
      if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= interactiveActionIds.length) {
        const action = interactiveActionIds[byIndex - 1];
        if (action) {
          return action;
        }
      }
      if (interactiveActionIds.includes(answer as InteractiveActionId)) {
        return answer as InteractiveActionId;
      }
      throw new Error("Invalid selection. Use a number from the list or an action id.");
    } finally {
      rl.close();
    }
  },
  catch: (cause) =>
    new DaemonCommandError({
      message: "Failed to read interactive action selection.",
      cause,
    }),
});

const runCliSubprocess = Effect.fn("runCliSubprocess")(function* (args: ReadonlyArray<string>) {
  const entryPath = process.argv[1]?.trim();
  if (!entryPath) {
    return yield* new DaemonCommandError({
      message: "Could not resolve CLI entry path for interactive command execution.",
    });
  }

  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = ChildProcess.spawn(process.execPath, [entryPath, ...args], {
          cwd: process.cwd(),
          stdio: "inherit",
          env: {
            ...process.env,
            ACE_CLI_SUPPRESS_BOOT_BANNER: "1",
          },
          windowsHide: true,
        });
        child.once("error", (cause) => {
          reject(cause);
        });
        child.once("exit", (code, signal) => {
          if (signal) {
            reject(new Error(`Interactive action terminated by signal ${signal}.`));
            return;
          }
          if (code !== 0) {
            reject(new Error(`Interactive action exited with code ${String(code ?? 0)}.`));
            return;
          }
          resolve();
        });
      }),
    catch: (cause) =>
      new DaemonCommandError({
        message: "Failed to execute interactive action.",
        cause,
      }),
  });
});

const interactiveCommand = Command.make("interactive", {
  action: Flag.choice("action", interactiveActionIds).pipe(
    Flag.withAlias("a"),
    Flag.withDescription("Run a quick action directly."),
    Flag.optional,
  ),
}).pipe(
  Command.withAlias("i"),
  Command.withDescription("Launch an interactive quick-action picker."),
  Command.withHandler(({ action }) =>
    Effect.gen(function* () {
      const selectedAction: InteractiveActionId = Option.isSome(action)
        ? action.value
        : yield* promptInteractiveAction;
      const selected = interactiveActions[selectedAction];
      yield* writeStdout(`${pc.dim("Running")} ace ${selected.argv.join(" ")}\n`);
      return yield* runCliSubprocess(selected.argv);
    }),
  ),
);

const rootCommand = Command.make("ace").pipe(
  Command.withDescription("ace CLI."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const animated = yield* playRootCliLogoAnimation;
      const banner = animated ? "" : formatRootCliBanner();
      const spacer = animated ? "\n" : "";
      return yield* writeStdout(`${banner}${spacer}${formatRootCliGuide()}\n`);
    }),
  ),
);

export const cli = rootCommand.pipe(
  Command.withSubcommands([
    serveCommand,
    profileCommand,
    projectCommand,
    remoteCommand,
    daemonCommand,
    interactiveCommand,
  ]),
);
