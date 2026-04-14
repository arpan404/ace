import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";

import pc from "picocolors";
import { NetService } from "@ace/shared/Net";
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
import { Config, Data, Effect, LogLevel, Option, Schema } from "effect";
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
import { runServer } from "./server";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

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

const serveCommand = Command.make("serve", {
  ...serveCommandFlags,
  workspaceRoot: openWorkspaceArgument,
}).pipe(
  Command.withDescription("Run the ace HTTP/WebSocket server."),
  Command.withHandler(({ workspaceRoot, ...flags }) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, workspaceRoot);
      return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
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
        return yield* new DaemonCommandError({
          message:
            "A daemon process appears to be running but is not healthy. Refusing to replace it automatically.",
        });
      }

      if (existingStatus.status === "stale") {
        yield* clearDaemonState(config.baseDir);
      }

      const authToken = config.authToken ?? Crypto.randomBytes(24).toString("hex");
      const pid = yield* spawnDaemonServer({
        config,
        authToken,
      });
      const now = new Date().toISOString();
      const state: AceServerDaemonState = {
        version: 1,
        pid,
        mode: config.mode,
        host: config.host ?? null,
        port: config.port,
        wsUrl: buildDaemonWsUrl(config.host ?? null, config.port, authToken),
        authToken,
        baseDir: config.baseDir,
        dbPath: config.dbPath,
        serverLogPath: config.serverLogPath,
        startedAt: now,
        updatedAt: now,
      };
      yield* writeDaemonState(state);

      const ready = yield* waitForDaemonReady(state, {
        timeoutMs: 10_000,
      });
      if (!ready) {
        yield* clearDaemonState(config.baseDir);
        return yield* new DaemonCommandError({
          message: "Daemon process did not become reachable before timeout.",
        });
      }

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
        const status = yield* readDaemonStatusPayload(config.baseDir);
        if (!status.state) {
          const payload = {
            status: "already-stopped" as const,
          };
          if (json) {
            return yield* writeJson(payload);
          }
          return yield* writeStdout(`${pc.yellow("Already stopped")} daemon not running\n`);
        }

        if (!status.processAlive) {
          yield* clearDaemonState(config.baseDir);
          const payload = {
            status: "cleared-stale-state" as const,
          };
          if (json) {
            return yield* writeJson(payload);
          }
          return yield* writeStdout(`${pc.yellow("Cleared")} stale daemon state\n`);
        }

        yield* sendSignal(status.state.pid, "SIGTERM");
        const exited = yield* waitForProcessExit(status.state.pid, { timeoutMs });
        if (!exited) {
          yield* sendSignal(status.state.pid, "SIGKILL");
          const forcedExit = yield* waitForProcessExit(status.state.pid, { timeoutMs: 2_000 });
          if (!forcedExit) {
            return yield* new DaemonCommandError({
              message: `Daemon process ${String(status.state.pid)} did not exit after SIGKILL.`,
            });
          }
        }
        yield* clearDaemonState(config.baseDir);

        const payload = {
          status: "stopped" as const,
          pid: status.state.pid,
        };
        if (json) {
          return yield* writeJson(payload);
        }
        return yield* writeStdout(
          `${pc.green("Stopped")} daemon pid=${String(status.state.pid)}\n`,
        );
      }),
    ),
  ),
);

const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Manage the persistent background ace server."),
  Command.withSubcommands([daemonStartCommand, daemonStatusCommand, daemonStopCommand]),
);

const rootBannerLines = [
  " █████╗  ██████╗███████╗",
  "██╔══██╗██╔════╝██╔════╝",
  "███████║██║     █████╗  ",
  "██╔══██║██║     ██╔══╝  ",
  "██║  ██║╚██████╗███████╗",
  "╚═╝  ╚═╝ ╚═════╝╚══════╝",
] as const;

const colorizeRootBannerLine = (line: string, index: number): string => {
  switch (index % 3) {
    case 0:
      return pc.cyan(line);
    case 1:
      return pc.magenta(line);
    default:
      return pc.blue(line);
  }
};

const formatRootCliBanner = (): string =>
  `${rootBannerLines.map((line, index) => colorizeRootBannerLine(line, index)).join("\n")}\n`;

const formatRootCliGuide = (): string =>
  [
    `${pc.bold("ace CLI")} ${pc.dim("unified local + remote control")}`,
    `${pc.bold("Quick start")}`,
    `  ${pc.cyan("ace serve")}          run server in foreground`,
    `  ${pc.cyan("ace daemon start")}   run reusable background daemon`,
    `  ${pc.cyan("ace project list")}   list saved local projects`,
    `  ${pc.cyan("ace remote list")}    list saved remote hosts`,
    `  ${pc.cyan("ace --help")}         show full command reference`,
  ].join("\n");

const playRootCliIntroAnimation = Effect.gen(function* () {
  if (!process.stdout.isTTY || process.env.CI === "1" || process.env.NO_COLOR !== undefined) {
    return;
  }
  const frames = ["-", "\\", "|", "/"] as const;
  for (const frame of frames) {
    yield* writeStdout(`\r${pc.magenta(frame)} ${pc.cyan("booting ace CLI")}`);
    yield* Effect.sleep("45 millis");
  }
  yield* writeStdout("\r\x1b[2K");
});

const rootCommand = Command.make("ace").pipe(
  Command.withDescription("ace CLI."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      yield* playRootCliIntroAnimation;
      return yield* writeStdout(`${formatRootCliBanner()}${formatRootCliGuide()}\n`);
    }),
  ),
);

export const cli = rootCommand.pipe(
  Command.withSubcommands([serveCommand, projectCommand, remoteCommand, daemonCommand]),
);
