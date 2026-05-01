import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Os from "node:os";
import * as Readline from "node:readline/promises";

import pc from "picocolors";
import QRCode from "qrcode";
import {
  DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM,
  WS_METHODS,
  type ServerRuntimeProfile,
} from "@ace/contracts";
import {
  buildRelayHostConnectionDraft,
  normalizeWsUrl,
  parseHostConnectionQrPayload,
  requestPairingClaim,
  waitForPairingApproval,
} from "@ace/shared/hostConnections";
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
  describeCliRemoteConnection,
  listCliRemoteConnections,
  removeCliRemoteConnection,
  remoteConnectionMatchesSelector,
  type CliRemoteConnectionSummary,
  CliRemoteConnectionServicesLive,
} from "./cliRemoteConnections";
import {
  createCliPairingSession,
  listCliPairingSessions,
  pingCliHostConnection,
  revokeCliPairingSession,
  type CliPairingSessionStatus,
} from "./cliPairing";
import { loadCliRelayDeviceIdentity } from "./cliRelayIdentity";
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
import { Open, OpenLive } from "./open";
import { resolveBaseDir } from "./os-jank";
import {
  buildProcessTree,
  deriveCpuPercentsFromCpuSeconds,
  sampleProcessTable,
  type ProcessProfileSample,
} from "./processProfile";
import { runServer } from "./server";
import { version as serverPackageVersion } from "../package.json" with { type: "json" };

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000;
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
const relayUrlFlag = Flag.string("relay-url").pipe(
  Flag.withDescription(
    "Override the default relay URL for this process (equivalent to ACE_RELAY_URL).",
  ),
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
  readonly relayUrl?: Option.Option<string>;
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
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl, mode);
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
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl, "web");
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
  relayUrl: relayUrlFlag,
} as const;

const webCommandFlags = {
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  relayUrl: relayUrlFlag,
} as const;

const dataCommandFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

const applyRelayUrlProcessOverride = (relayUrl: Option.Option<string>) =>
  Effect.sync(() => {
    const resolved = Option.getOrUndefined(relayUrl)?.trim();
    if (resolved && resolved.length > 0) {
      process.env.ACE_RELAY_URL = resolved;
    }
  });

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

const promptForUpdateConfirmation = Effect.tryPromise({
  try: async (): Promise<boolean> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Updating while the daemon is running requires an interactive terminal confirmation.",
      );
    }

    const rl = Readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const answer = (
        await rl.question(
          `${pc.yellow(
            "A background ace daemon is running. Updating will stop any running agents. Continue? [y/N] ",
          )}`,
        )
      )
        .trim()
        .toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  },
  catch: (cause) =>
    new DaemonCommandError({
      message: "Could not confirm app update.",
      cause,
    }),
});

const launchDesktopUpdate = Effect.fn("launchDesktopUpdate")(function* () {
  if (process.versions.electron === undefined) {
    return yield* new DaemonCommandError({
      message: "`ace update` is only available from the CLI installed by the packaged desktop app.",
    });
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = ChildProcess.spawn(process.execPath, ["--ace-update"], {
          cwd: process.cwd(),
          stdio: "inherit",
          env,
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal) {
            reject(new Error(`Desktop updater terminated by signal ${signal}.`));
            return;
          }
          if (code !== 0) {
            reject(new Error(`Desktop updater exited with code ${String(code ?? 0)}.`));
            return;
          }
          resolve();
        });
      }),
    catch: (cause) =>
      new DaemonCommandError({
        message: "Failed to launch desktop updater.",
        cause,
      }),
  });
});

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
  const headers = ["THREADS", "TITLE", "PATH"] as const;
  const rows = projects.map((project) => [
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

const formatRemoteConnectionTarget = (connection: CliRemoteConnectionSummary): string => {
  const descriptor = describeCliRemoteConnection(connection);
  return descriptor.mode === "relay"
    ? `${descriptor.target} (${descriptor.detail})`
    : descriptor.target;
};

const formatRemoteConnectionRows = (
  connections: ReadonlyArray<CliRemoteConnectionSummary>,
): string => {
  if (connections.length === 0) {
    return `${pc.dim("No remote connections saved yet.")}\n`;
  }
  const headers = ["ID", "NAME", "MODE", "TARGET", "TOKEN", "UPDATED"] as const;
  const rows = connections.map((connection) => [
    connection.id,
    connection.name,
    describeCliRemoteConnection(connection).mode,
    formatRemoteConnectionTarget(connection),
    maskToken(connection.authToken),
    connection.updatedAt,
  ]);
  return formatRows(headers, rows);
};

const formatPairingSessionRows = (sessions: ReadonlyArray<CliPairingSessionStatus>): string => {
  if (sessions.length === 0) {
    return `${pc.dim("No pairing sessions found.")}\n`;
  }
  const headers = ["LABEL", "REQUESTER", "STATUS", "PAIRED AT", "EXPIRES", "SESSION"] as const;
  const rows = sessions.map((session) => [
    session.name,
    session.requesterName ?? "-",
    session.status,
    session.resolvedAt ?? "-",
    session.expiresAt,
    session.sessionId,
  ]);
  return formatRows(headers, rows);
};

const promptPairingSessionSelection = (sessions: ReadonlyArray<CliPairingSessionStatus>) =>
  Effect.tryPromise({
    try: async (): Promise<string> => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "Interactive pairing revoke requires a TTY. Pass a session id explicitly in non-interactive environments.",
        );
      }
      if (sessions.length === 0) {
        throw new Error("No pairing sessions are available for interactive revoke.");
      }
      const rl = Readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        process.stdout.write(`${pc.bold("Select pairing session to revoke")}\n`);
        sessions.forEach((session, index) => {
          const requester = session.requesterName ?? "pending claim";
          const pairedAt = session.resolvedAt ?? "pending";
          process.stdout.write(
            `  ${pc.cyan(String(index + 1))}. ${session.name} ${pc.dim(
              `(${requester}, ${session.status}, paired ${pairedAt})`,
            )}\n`,
          );
        });
        const answer = (await rl.question(`${pc.magenta("›")} `)).trim();
        const byIndex = Number.parseInt(answer, 10);
        if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= sessions.length) {
          const selected = sessions[byIndex - 1];
          if (selected) {
            return selected.sessionId;
          }
        }
        const bySessionId = sessions.find((session) => session.sessionId === answer);
        if (bySessionId) {
          return bySessionId.sessionId;
        }
        throw new Error("Invalid selection. Use a list number or session id.");
      } finally {
        rl.close();
      }
    },
    catch: (cause) =>
      new DaemonCommandError({
        message: "Failed to resolve interactive pairing session selection.",
        cause,
      }),
  });

const promptRemoteConnectionSelection = (
  connections: ReadonlyArray<CliRemoteConnectionSummary>,
  purpose: "remove" | "ping",
) =>
  Effect.tryPromise({
    try: async (): Promise<string> => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          `Interactive remote ${purpose} requires a TTY. Pass a selector in non-interactive environments.`,
        );
      }
      if (connections.length === 0) {
        throw new Error("No linked remote hosts found.");
      }
      const rl = Readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        process.stdout.write(
          `${pc.bold(
            purpose === "remove"
              ? "Select linked remote host to remove"
              : "Select linked remote host to ping",
          )}\n`,
        );
        process.stdout.write(`  ${pc.cyan("0")}. ${pc.dim("all linked hosts")}\n`);
        connections.forEach((connection, index) => {
          process.stdout.write(
            `  ${pc.cyan(String(index + 1))}. ${connection.name} ${pc.dim(`(${formatRemoteConnectionTarget(connection)})`)}\n`,
          );
        });
        const answer = (await rl.question(`${pc.magenta("›")} `)).trim();
        if (answer === "0" || answer.toLowerCase() === "all") {
          return "__all__";
        }
        const byIndex = Number.parseInt(answer, 10);
        if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= connections.length) {
          const selected = connections[byIndex - 1];
          if (selected) {
            return selected.id;
          }
        }
        const bySelector = connections.find((connection) =>
          remoteConnectionMatchesSelector(connection, answer),
        );
        if (bySelector) {
          return bySelector.id;
        }
        throw new Error(
          "Invalid selection. Use a list number, id, name, target, relay host, host device id, or 0 for all.",
        );
      } finally {
        rl.close();
      }
    },
    catch: (cause) =>
      new DaemonCommandError({
        message: `Failed to resolve interactive remote ${purpose} selection.`,
        cause,
      }),
  });

const renderQrToken = (token: string) =>
  Effect.tryPromise({
    try: () =>
      QRCode.toString(token, {
        type: "terminal",
        small: true,
      }),
    catch: (cause) =>
      new DaemonCommandError({
        message: "Failed to render pairing QR in terminal output.",
        cause,
      }),
  });

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

function buildBar(
  value: number,
  max: number,
  width: number,
  colorFn: (s: string) => string,
): string {
  if (max <= 0) {
    return colorFn("─".repeat(width));
  }
  const filled = Math.round((Math.min(value, max) / max) * width);
  const empty = width - filled;
  return colorFn("█".repeat(filled)) + pc.dim("░".repeat(empty));
}

function buildCpuBar(cpuPercent: number | null): string {
  const value = cpuPercent ?? 0;
  return buildBar(value, 100, 20, (s) => {
    if (value > 80) return pc.red(s);
    if (value > 50) return pc.yellow(s);
    return pc.green(s);
  });
}

function buildMemoryBar(rssBytes: number): string {
  return buildBar(rssBytes, 8 * 1024 * 1024 * 1024, 20, (s) => {
    const gb = rssBytes / (1024 * 1024 * 1024);
    if (gb > 6) return pc.red(s);
    if (gb > 4) return pc.yellow(s);
    return pc.cyan(s);
  });
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
  const errorLine =
    input.runtimeProfileError === null
      ? ""
      : pc.yellow(`Runtime profile unavailable: ${input.runtimeProfileError}`);

  const cpuBar = buildCpuBar(input.processTree.totalCpuPercent);
  const memBar = buildMemoryBar(input.processTree.totalRssBytes);
  const cpuPercent = formatCpuPercent(input.processTree.totalCpuPercent);
  const memDisplay = formatByteCount(input.processTree.totalRssBytes);

  const line1 = pc.bold(pc.cyan("ace")) + pc.dim(" process monitor  ") + pc.dim("│");
  const line2 =
    pc.dim("  PID ") +
    pc.bold(pc.white(String(input.targetPid))) +
    pc.dim(" │ ") +
    pc.dim("refresh ") +
    pc.white(String(input.intervalMs)) +
    pc.dim("ms │ ") +
    pc.dim("sampled ") +
    pc.white(input.sampledAt.split("T")[1]?.split(".")[0] ?? input.sampledAt);

  const barSection = pc.dim(
    "┌─ " +
      "CPU".padEnd(22) +
      "MEM".padEnd(22) +
      pc.dim(" ─┐\n") +
      "│  " +
      pc.bold(pc.dim("cpu")) +
      pc.dim(" ") +
      cpuBar +
      pc.dim(" ") +
      pc.bold(pc.dim("mem")) +
      pc.dim(" ") +
      memBar +
      pc.dim("  │\n") +
      pc.dim("│  ") +
      pc.white(cpuPercent.padEnd(18)) +
      pc.dim("       ") +
      pc.white(memDisplay.padEnd(22)) +
      pc.dim("  │\n") +
      pc.dim("└" + "─".repeat(54) + "┘"),
  );

  const statSection = runtimeProfile
    ? [
        pc.dim("┌─ " + pc.bold("Runtime") + pc.dim(" ".repeat(44) + " ─┐")),
        `│  ${pc.bold(pc.dim("platform"))}  ${pc.white(runtimeProfile.process.platform.padEnd(40))}  │`,
        `│  ${pc.bold(pc.dim("node"))}       ${pc.white(runtimeProfile.process.nodeVersion.padEnd(40))}  │`,
        `│  ${pc.bold(pc.dim("uptime"))}     ${pc.white(formatUptimeSeconds(runtimeProfile.process.uptimeSeconds).padEnd(40))}  │`,
        pc.dim("│  " + " ".repeat(52) + "  │"),
        `│  ${pc.bold(pc.dim("heap"))}       ${pc.white(formatByteCount(runtimeProfile.process.heapUsedBytes).padEnd(16) + "/" + formatByteCount(runtimeProfile.process.heapTotalBytes).padEnd(16))}  │`,
        `│  ${pc.bold(pc.dim("external"))}    ${pc.white(formatByteCount(runtimeProfile.process.externalBytes).padEnd(40))}  │`,
        `│  ${pc.bold(pc.dim("buffers"))}    ${pc.white(formatByteCount(runtimeProfile.process.arrayBuffersBytes).padEnd(40))}  │`,
        pc.dim("│  " + " ".repeat(52) + "  │"),
        `│  ${pc.bold(pc.dim("sessions"))}   ${pc.white(formatProviderSessionCounts(runtimeProfile).padEnd(40))}  │`,
        pc.dim("└" + "─".repeat(54) + "┘"),
      ].join("\n")
    : "";

  const processSection =
    pc.dim(
      "┌─ " +
        pc.bold("Processes") +
        pc.dim(` (${input.processTree.processes.length})`.padEnd(44) + " ─┐"),
    ) +
    "\n" +
    processTable
      .split("\n")
      .map((line) => (line.trim() ? `│  ${line.padEnd(52)}  │` : ""))
      .join("\n") +
    pc.dim("\n└" + "─".repeat(54) + "┘");

  return [
    line1,
    line2,
    "",
    barSection,
    errorLine ? `\n\n${errorLine}` : "",
    "",
    statSection,
    "",
    processSection,
    "",
    pc.dim("  Ctrl+C to exit"),
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
    const config = yield* resolveDataConfig(flags, Option.some("Error" as LogLevel.LogLevel));
    const configWithSilentLog = { ...config, logLevel: "Fatal" as LogLevel.LogLevel };
    return yield* effect.pipe(
      Effect.provide(CliProjectServicesLive),
      Effect.provideService(ServerConfig, configWithSilentLog),
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

const resolveLocalDaemonConnection = Effect.fn("resolveLocalDaemonConnection")(function* (
  flags: CliDataFlags,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveDataConfig(flags, logLevel);
  const daemonStatus = yield* readDaemonStatusPayload(config.baseDir);
  if (daemonStatus.status !== "running" || !daemonStatus.state) {
    return yield* new DaemonCommandError({
      message: "Daemon is not running. Start it with `ace serve` or `ace daemon start`.",
    });
  }
  return {
    wsUrl: daemonStatus.state.wsUrl,
    authToken: daemonStatus.state.authToken,
  } as const;
});

const resolveRemoteLinkDraft = Effect.fn("resolveRemoteLinkDraft")(function* (
  flags: CliDataFlags,
  token: string,
) {
  const parsed = parseHostConnectionQrPayload(token);
  if (!parsed) {
    return yield* new DaemonCommandError({
      message: "Invalid token. Use a pairing token (ace://pair?...) or host URL.",
    });
  }
  if (parsed.kind === "direct") {
    return parsed.draft;
  }
  if (
    parsed.pairing.relayUrl &&
    parsed.pairing.hostDeviceId &&
    parsed.pairing.hostIdentityPublicKey
  ) {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveDataConfig(flags, logLevel);
    const viewerIdentity = yield* Effect.promise(() => loadCliRelayDeviceIdentity(config.stateDir));
    return buildRelayHostConnectionDraft({
      pairing: parsed.pairing,
      viewerIdentity,
    });
  }
  const receipt = yield* Effect.promise(() =>
    requestPairingClaim(parsed.pairing, {
      requesterName: "ace cli",
    }),
  );
  return yield* Effect.promise(() =>
    waitForPairingApproval(receipt, {
      timeoutMs: 120_000,
      pollIntervalMs: 1_200,
    }),
  );
});

export const shouldRunServeInForeground = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.ACE_DAEMONIZED === "1";

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

const normalizeDaemonHttpHost = (host: string | null): string => {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "localhost";
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
};

const buildDaemonHttpUrl = (state: AceServerDaemonState): string =>
  `http://${normalizeDaemonHttpHost(state.host)}:${state.port}`;

const buildDaemonWebAppUrl = (state: AceServerDaemonState): string => {
  const parsed = new URL(buildDaemonHttpUrl(state));
  parsed.searchParams.set(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM, state.wsUrl);
  return parsed.toString();
};

const openBrowserTarget = (target: string) =>
  Effect.gen(function* () {
    const { openBrowser } = yield* Open;
    yield* openBrowser(target);
  }).pipe(
    Effect.provide(OpenLive),
    Effect.catch(() =>
      writeStdout(
        `${pc.yellow("Browser auto-open unavailable")}. Open ${target} in your browser.\n`,
      ),
    ),
  );

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

const terminateSpawnedDaemonAfterFailedStart = Effect.fn("terminateSpawnedDaemonAfterFailedStart")(
  function* (input: {
    readonly pid: number;
    readonly baseDir: string;
    readonly timeoutMs: number;
  }) {
    const exitedNaturally = yield* waitForProcessExit(input.pid, {
      timeoutMs: 250,
    });
    if (!exitedNaturally) {
      yield* sendSignal(input.pid, "SIGTERM");
      const exitedGracefully = yield* waitForProcessExit(input.pid, {
        timeoutMs: input.timeoutMs,
      });
      if (!exitedGracefully) {
        yield* sendSignal(input.pid, "SIGKILL");
        const forcedExit = yield* waitForProcessExit(input.pid, { timeoutMs: 2_000 });
        if (!forcedExit) {
          return yield* new DaemonCommandError({
            message: `Daemon process ${String(input.pid)} did not exit after startup timeout.`,
          });
        }
      }
    }

    yield* clearDaemonState(input.baseDir);
  },
);

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
    timeoutMs: DEFAULT_DAEMON_START_TIMEOUT_MS,
  });
  if (!ready) {
    const cleanupExit = yield* terminateSpawnedDaemonAfterFailedStart({
      pid,
      baseDir: input.config.baseDir,
      timeoutMs: DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
    }).pipe(Effect.exit);
    if (Exit.isFailure(cleanupExit)) {
      return yield* new DaemonCommandError({
        message:
          "Daemon process did not become reachable before timeout and could not be stopped cleanly.",
        cause: cleanupExit.cause,
      });
    }
    return yield* new DaemonCommandError({
      message: "Daemon process did not become reachable before timeout.",
    });
  }

  return state;
});

const ensureDaemonStarted = Effect.fn("ensureDaemonStarted")(function* (input: {
  readonly config: ServerConfigShape;
}) {
  const existingStatus = yield* readDaemonStatusPayload(input.config.baseDir);
  if (existingStatus.state && existingStatus.processAlive) {
    const eventuallyReady = yield* waitForDaemonReady(existingStatus.state, {
      timeoutMs: DEFAULT_DAEMON_START_TIMEOUT_MS,
    });
    if (eventuallyReady) {
      if (isDaemonStateCurrentVersion(existingStatus.state)) {
        return {
          status: "already-running" as const,
          daemon: existingStatus.state,
        };
      }

      const stopResult = yield* stopDaemonIfPresent({
        baseDir: input.config.baseDir,
        timeoutMs: DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
      });
      const state = yield* startDaemonAndPersistState({
        config: input.config,
      });
      return {
        status: "started" as const,
        daemon: state,
        upgraded: true as const,
        previousVersion: existingStatus.state.serverVersion,
        stop: stopResult,
      };
    }

    const stopResult = yield* stopDaemonIfPresent({
      baseDir: input.config.baseDir,
      timeoutMs: DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
    });
    const state = yield* startDaemonAndPersistState({
      config: input.config,
    });
    return {
      status: "started" as const,
      daemon: state,
      recovered: true as const,
      replacedPid: existingStatus.state.pid,
      stop: stopResult,
    };
  }

  if (existingStatus.status === "stale") {
    yield* clearDaemonState(input.config.baseDir);
  }
  const state = yield* startDaemonAndPersistState({
    config: input.config,
  });
  return {
    status: "started" as const,
    daemon: state,
  };
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
  Command.withDescription("Run or attach to the persistent background ace server daemon."),
  Command.withHandler(({ workspaceRoot, ...flags }) =>
    Effect.gen(function* () {
      yield* applyRelayUrlProcessOverride(flags.relayUrl);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, workspaceRoot);
      if (shouldRunServeInForeground()) {
        return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
      }
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

const webCommand = Command.make("web", {
  ...webCommandFlags,
  workspaceRoot: openWorkspaceArgument,
}).pipe(
  Command.withDescription("Open the ace web app by reusing or starting the background daemon."),
  Command.withHandler(({ workspaceRoot, ...flags }) =>
    Effect.gen(function* () {
      yield* applyRelayUrlProcessOverride(flags.relayUrl);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(
        {
          ...flags,
          mode: Option.some("web"),
        },
        logLevel,
        workspaceRoot,
      );
      const daemonResult = yield* ensureDaemonStarted({ config });
      const webUrl = buildDaemonWebAppUrl(daemonResult.daemon);

      if (daemonResult.status === "already-running") {
        yield* writeStdout(
          `${pc.green("Using daemon")} pid=${String(daemonResult.daemon.pid)} ${daemonResult.daemon.wsUrl}\n`,
        );
      } else {
        yield* writeStdout(
          `${pc.green("Started daemon")} pid=${String(daemonResult.daemon.pid)} ${daemonResult.daemon.wsUrl}\n`,
        );
      }

      if (!config.noBrowser) {
        yield* openBrowserTarget(webUrl);
      }
      return yield* writeStdout(`${pc.green("Web ready")} ${webUrl}\n`);
    }),
  ),
);

const updateCommand = Command.make("update", {
  ...dataCommandFlags,
}).pipe(
  Command.withDescription("Update the packaged ace desktop app."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveDataConfig(flags, logLevel);
      const daemonStatus = yield* readDaemonStatusPayload(config.baseDir);

      if (daemonStatus.status === "running") {
        const confirmed = yield* promptForUpdateConfirmation;
        if (!confirmed) {
          return yield* writeStdout(`${pc.yellow("Cancelled")} update not started.\n`);
        }
      }

      yield* writeStdout(`${pc.green("Launching")} desktop updater...\n`);
      return yield* launchDesktopUpdate();
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

const remoteCreateCommand = Command.make("create", {
  ...dataCommandFlags,
  deviceName: Flag.string("device-name").pipe(
    Flag.withDescription("Label shown while pairing this host."),
  ),
  relayUrl: relayUrlFlag,
  wait: Flag.boolean("wait").pipe(
    Flag.withDescription("Wait for status updates until paired/revoked/expired."),
    Flag.withDefault(true),
  ),
  waitTimeoutMs: Flag.integer("wait-timeout-ms").pipe(
    Flag.withDescription("How long to wait for pairing status updates."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a host pairing token and QR for remote linking."),
  Command.withHandler(({ deviceName, relayUrl, wait, waitTimeoutMs, json, ...flags }) =>
    Effect.gen(function* () {
      const host = yield* resolveLocalDaemonConnection(flags);
      const relayUrlOverride = Option.getOrUndefined(relayUrl);
      const result = yield* Effect.promise(() =>
        createCliPairingSession({
          wsUrl: host.wsUrl,
          authToken: host.authToken,
          name: deviceName,
          ...(relayUrlOverride ? { relayUrl: relayUrlOverride } : {}),
        }),
      );
      const qr = yield* renderQrToken(result.connectionString);
      const statusLabel = (status: CliPairingSessionStatus["status"]) => {
        switch (status) {
          case "approved":
            return pc.green(status);
          case "rejected":
          case "expired":
            return pc.red(status);
          default:
            return pc.yellow(status);
        }
      };

      if (json) {
        return yield* writeJson({
          ...result,
          qr,
        });
      }

      yield* writeStdout(
        [
          `${pc.green("Created")} pairing session ${result.sessionId} ${pc.dim(`(expires ${result.expiresAt})`)}`,
          `${pc.bold("Device label:")} ${result.name}`,
          `${pc.bold("Pairing token:")} ${result.connectionString}`,
          `${pc.bold("Pairing status:")} ${statusLabel(result.status)}`,
          "",
          qr,
        ].join("\n") + "\n",
      );

      if (!wait) {
        return;
      }

      const timeoutMs = Math.max(
        1_000,
        Option.isSome(waitTimeoutMs) ? waitTimeoutMs.value : 120_000,
      );
      const startedAt = Date.now();
      let lastStatus = result.status;
      while (lastStatus === "waiting-claim" || lastStatus === "claim-pending") {
        if (Date.now() - startedAt >= timeoutMs) {
          yield* writeStdout(`${pc.yellow("Pairing status wait timed out.")}\n`);
          break;
        }
        yield* Effect.sleep("1200 millis");
        const sessions = yield* Effect.promise(() =>
          listCliPairingSessions({
            wsUrl: host.wsUrl,
            authToken: host.authToken,
          }),
        );
        const current = sessions.find((session) => session.sessionId === result.sessionId);
        if (!current) {
          yield* writeStdout(`${pc.yellow("Pairing session no longer exists on host.")}\n`);
          break;
        }
        if (current.status !== lastStatus) {
          lastStatus = current.status;
          const requesterSuffix = current.requesterName
            ? ` ${pc.dim(`(${current.requesterName})`)}`
            : "";
          yield* writeStdout(
            `${pc.bold("Pairing status:")} ${statusLabel(current.status)}${requesterSuffix}\n`,
          );
        }
      }
    }),
  ),
);

const remoteListCommand = Command.make("list", {
  ...dataCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List pairing sessions/devices granted access by this host."),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      const host = yield* resolveLocalDaemonConnection(flags);
      const sessions = yield* Effect.promise(() =>
        listCliPairingSessions({
          wsUrl: host.wsUrl,
          authToken: host.authToken,
        }),
      );
      if (json) {
        return yield* writeJson(sessions);
      }
      return yield* writeStdout(formatPairingSessionRows(sessions));
    }),
  ),
);

const remoteRevokeCommand = Command.make("revoke", {
  ...dataCommandFlags,
  session: Argument.string("session").pipe(
    Argument.withDescription("Pairing session id to revoke."),
    Argument.optional,
  ),
  interactive: Flag.boolean("interactive").pipe(
    Flag.withAlias("i"),
    Flag.withDescription("Choose session interactively."),
    Flag.withDefault(true),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Revoke host-side pairing access."),
  Command.withHandler(({ session, interactive, json, ...flags }) =>
    Effect.gen(function* () {
      const host = yield* resolveLocalDaemonConnection(flags);
      const sessions = yield* Effect.promise(() =>
        listCliPairingSessions({
          wsUrl: host.wsUrl,
          authToken: host.authToken,
        }),
      );
      if (sessions.length === 0) {
        return yield* new DaemonCommandError({
          message: "No pairing sessions found to revoke.",
        });
      }
      const revokable = sessions.filter(
        (entry) =>
          entry.status === "waiting-claim" ||
          entry.status === "claim-pending" ||
          entry.status === "approved",
      );
      if (revokable.length === 0) {
        return yield* new DaemonCommandError({
          message: "No active pairing sessions can be revoked.",
        });
      }
      const sessionId =
        Option.isSome(session) && !interactive
          ? session.value
          : yield* promptPairingSessionSelection(revokable);
      const result = yield* Effect.promise(() =>
        revokeCliPairingSession({
          wsUrl: host.wsUrl,
          authToken: host.authToken,
          sessionId,
        }),
      );
      if (json) {
        return yield* writeJson(result);
      }
      return yield* writeStdout(
        `${pc.green("Revoked")} access for "${result.name}" (${result.sessionId}).\n`,
      );
    }),
  ),
);

const remoteLinkCommand = Command.make("link", {
  ...dataCommandFlags,
  token: Flag.string("token").pipe(
    Flag.withDescription("Pairing token generated by `ace remote create`."),
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Optional local display name override."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Claim a pairing token and save the remote host."),
  Command.withHandler(({ token, name, json, ...flags }) =>
    Effect.gen(function* () {
      const draft = yield* resolveRemoteLinkDraft(flags, token);
      const result = yield* runCliRemoteConnectionCommand(
        flags,
        addCliRemoteConnection({
          wsUrl: draft.wsUrl,
          ...(draft.authToken
            ? {
                authToken: draft.authToken,
              }
            : {}),
          ...(Option.isSome(name)
            ? {
                name: name.value,
              }
            : draft.name
              ? {
                  name: draft.name,
                }
              : {}),
        }),
      );
      if (json) {
        return yield* writeJson(result);
      }
      const verb = result.status === "created" ? pc.green("Linked") : pc.yellow("Updated");
      return yield* writeStdout(
        `${verb} remote "${result.connection.name}" (${formatRemoteConnectionTarget(result.connection)}) [${result.connection.id}]\n`,
      );
    }),
  ),
);

const remoteRemoveCommand = Command.make("remove", {
  ...dataCommandFlags,
  selector: Argument.string("remote").pipe(
    Argument.withDescription("Remote id/name/ws-url. Use 'all' to remove all."),
    Argument.optional,
  ),
  interactive: Flag.boolean("interactive").pipe(
    Flag.withAlias("i"),
    Flag.withDescription("Choose a linked remote interactively when selector is omitted."),
    Flag.withDefault(true),
  ),
  json: jsonFlag,
}).pipe(
  Command.withAlias("delete"),
  Command.withDescription("Remove linked remote host connections."),
  Command.withHandler(({ selector, interactive, json, ...flags }) =>
    Effect.gen(function* () {
      const connections = yield* runCliRemoteConnectionCommand(flags, listCliRemoteConnections);
      if (connections.length === 0) {
        return yield* new DaemonCommandError({
          message: "No linked remote hosts found.",
        });
      }
      const selected = Option.isSome(selector)
        ? selector.value
        : interactive
          ? yield* promptRemoteConnectionSelection(connections, "remove")
          : yield* new DaemonCommandError({
              message: "Provide a remote selector or enable interactive mode.",
            });
      const selectors =
        selected === "__all__" || selected === "all"
          ? connections.map((connection) => connection.id)
          : [selected];
      const uniqueSelectors = Array.from(new Set(selectors));
      const removed: Array<CliRemoteConnectionSummary> = [];
      for (const item of uniqueSelectors) {
        const result = yield* runCliRemoteConnectionCommand(
          flags,
          removeCliRemoteConnection({ selector: item }),
        );
        removed.push(result.connection);
      }
      if (json) {
        return yield* writeJson(removed);
      }
      if (removed.length === 1) {
        const entry = removed[0];
        if (!entry) {
          return;
        }
        return yield* writeStdout(
          `${pc.green("Removed")} remote "${entry.name}" (${formatRemoteConnectionTarget(entry)}).\n`,
        );
      }
      yield* writeStdout(`${pc.green("Removed")} ${String(removed.length)} remote hosts.\n`);
      return yield* writeStdout(formatRemoteConnectionRows(removed));
    }),
  ),
);

const remotePingCommand = Command.make("ping", {
  ...dataCommandFlags,
  selector: Argument.string("remote").pipe(
    Argument.withDescription("Remote id/name/ws-url. Use 'all' to ping every linked host."),
    Argument.optional,
  ),
  interactive: Flag.boolean("interactive").pipe(
    Flag.withAlias("i"),
    Flag.withDescription("Choose linked remote host interactively when selector is omitted."),
    Flag.withDefault(true),
  ),
  once: Flag.boolean("once").pipe(
    Flag.withDescription("Run a single ping round and exit."),
    Flag.withDefault(false),
  ),
  timeoutMs: Flag.integer("timeout-ms").pipe(
    Flag.withDescription("HTTP timeout per ping attempt."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Continuously ping linked remote hosts."),
  Command.withHandler(({ selector, interactive, once, timeoutMs, json, ...flags }) =>
    Effect.gen(function* () {
      const connections = yield* runCliRemoteConnectionCommand(flags, listCliRemoteConnections);
      if (connections.length === 0) {
        return yield* new DaemonCommandError({
          message: "No linked remote hosts found.",
        });
      }
      const resolvedSelector = Option.isSome(selector)
        ? selector.value
        : interactive
          ? yield* promptRemoteConnectionSelection(connections, "ping")
          : "__all__";
      const logLevel = yield* GlobalFlag.LogLevel;
      const dataConfig = yield* resolveDataConfig(flags, logLevel);
      const selectedConnections =
        resolvedSelector === "__all__" || resolvedSelector === "all"
          ? connections
          : connections.filter((entry) => remoteConnectionMatchesSelector(entry, resolvedSelector));
      if (selectedConnections.length === 0) {
        return yield* new DaemonCommandError({
          message: `No linked remote matched '${resolvedSelector}'.`,
        });
      }
      if (json && !once) {
        return yield* new DaemonCommandError({
          message: "JSON output for `ace remote ping` requires --once.",
        });
      }
      const resolvedTimeoutMs = Math.max(250, Option.isSome(timeoutMs) ? timeoutMs.value : 4_000);
      const renderStatus = (status: "available" | "unauthenticated" | "unavailable") => {
        switch (status) {
          case "available":
            return pc.green(status);
          case "unauthenticated":
            return pc.yellow(status);
          case "unavailable":
            return pc.red(status);
        }
      };
      while (true) {
        const startedAt = new Date().toISOString();
        const pingRows = yield* Effect.all(
          selectedConnections.map((connection) =>
            Effect.promise(() =>
              pingCliHostConnection({
                wsUrl: connection.wsUrl,
                authToken: connection.authToken,
                timeoutMs: resolvedTimeoutMs,
                stateDir: dataConfig.stateDir,
              }),
            ).pipe(
              Effect.map((ping) => ({
                connection,
                ping,
              })),
            ),
          ),
        );
        if (json) {
          return yield* writeJson(
            pingRows.map((entry) => ({
              id: entry.connection.id,
              name: entry.connection.name,
              wsUrl: entry.connection.wsUrl,
              ...entry.ping,
            })),
          );
        }
        const table = formatRows(
          ["TIME", "DEVICE", "STATUS", "LATENCY", "DETAIL"],
          pingRows.map((entry) => [
            startedAt,
            entry.connection.name,
            renderStatus(entry.ping.status),
            `${String(entry.ping.latencyMs)}ms`,
            entry.ping.detail ?? "-",
          ]),
        );
        yield* writeStdout(table);
        if (once) {
          return;
        }
        const nextDelayMs = Math.floor(4_990 + Math.random() * 5_011);
        yield* Effect.sleep(nextDelayMs);
      }
    }),
  ),
);

const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage host pairing and linked remote connections."),
  Command.withSubcommands([
    remoteCreateCommand,
    remoteListCommand,
    remoteRevokeCommand,
    remoteLinkCommand,
    remoteRemoveCommand,
    remotePingCommand,
  ]),
);

const daemonStartCommand = Command.make("start", {
  ...serveCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start the ace server daemon in the background (idempotent)."),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      yield* applyRelayUrlProcessOverride(flags.relayUrl);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(
        {
          ...flags,
          noBrowser: Option.some(true),
        },
        logLevel,
      );
      const result = yield* ensureDaemonStarted({ config });
      if (json) {
        return yield* writeJson(result);
      }
      if (result.status === "already-running") {
        return yield* writeStdout(
          `${pc.yellow("Already running")} daemon pid=${String(result.daemon.pid)} ${result.daemon.wsUrl}\n`,
        );
      }
      if ("upgraded" in result) {
        return yield* writeStdout(
          `${pc.green("Started")} daemon pid=${String(result.daemon.pid)} ${result.daemon.wsUrl} ${pc.dim(
            `(upgraded from ${result.previousVersion})`,
          )}\n`,
        );
      }
      if ("recovered" in result) {
        return yield* writeStdout(
          `${pc.green("Started")} daemon pid=${String(result.daemon.pid)} ${result.daemon.wsUrl} ${pc.dim(
            `(replaced unhealthy pid ${String(result.replacedPid)})`,
          )}\n`,
        );
      }
      return yield* writeStdout(
        `${pc.green("Started")} daemon pid=${String(result.daemon.pid)} ${result.daemon.wsUrl}\n`,
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
      yield* applyRelayUrlProcessOverride(flags.relayUrl);
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
    `  ${pc.cyan("ace --web")}              open ace web app in your browser`,
    `  ${pc.cyan("ace serve")}              run or attach to background daemon`,
    `  ${pc.cyan("ace --update")}           update the packaged desktop app`,
    `  ${pc.cyan("ace --profile")}          live ace-specific process/memory profiler`,
    `  ${pc.cyan("ace daemon start")}       run reusable background daemon`,
    `  ${pc.cyan("ace --restart")}          restart background daemon`,
    `  ${pc.cyan("ace interactive")}        launch quick interactive command picker`,
    `  ${pc.cyan("ace project list")}       list saved local projects`,
    `  ${pc.cyan('ace remote create --device-name="Macbook Pro"')}  create pairing token + QR`,
    `  ${pc.cyan("ace remote list")}        list paired devices/sessions`,
    `  ${pc.cyan("ace remote ping")}        continuously ping linked remotes`,
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
  "web",
  "serve",
  "update",
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
  web: {
    description: "Open ace web app",
    argv: ["web"],
  },
  serve: {
    description: "Run or attach to daemon",
    argv: ["serve"],
  },
  update: {
    description: "Update packaged desktop app",
    argv: ["update"],
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
    description: "List paired devices and sessions",
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
    webCommand,
    serveCommand,
    updateCommand,
    profileCommand,
    projectCommand,
    remoteCommand,
    daemonCommand,
    interactiveCommand,
  ]),
);
