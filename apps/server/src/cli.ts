import { type CliProjectSummary, CliProjectServicesLive } from "./cliProjects";
import { addCliProject, listCliProjects, removeCliProject } from "./cliProjects";
import { normalizeCliWorkspaceRoot } from "./cliPaths";
import { NetService } from "@ace/shared/Net";
import { Config, Effect, LogLevel, Option, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
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
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
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

const commandFlags = {
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

const openWorkspaceArgument = Argument.string("workspace").pipe(
  Argument.withDescription("Workspace path to bootstrap on launch."),
  Argument.optional,
);

const rootCommandConfig = {
  ...commandFlags,
  workspaceRoot: openWorkspaceArgument,
} as const;
const baseCommand = Command.make("ace", rootCommandConfig);

const rootCommand = baseCommand.pipe(
  Command.withDescription("Open ace. Pass a workspace path to bootstrap it on launch."),
  Command.withHandler(({ workspaceRoot, ...flags }) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, workspaceRoot);
      return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);

const runCliProjectCommand = <A, E, R>(flags: CliServerFlags, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel);

    return yield* effect.pipe(
      Effect.provide(CliProjectServicesLive),
      Effect.provideService(ServerConfig, config),
    );
  });

const writeStdout = (output: string) =>
  Effect.sync(() => {
    process.stdout.write(output);
  });

const formatProjectRows = (projects: ReadonlyArray<CliProjectSummary>): string => {
  if (projects.length === 0) {
    return "No projects added yet.\n";
  }

  const headers = ["ID", "THREADS", "TITLE", "PATH"] as const;
  const rows = projects.map((project) => [
    project.id,
    String(project.activeThreadCount),
    project.title,
    project.workspaceRoot,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (columns: ReadonlyArray<string>) =>
    columns.map((column, index) => column.padEnd(widths[index]!)).join("  ");

  return `${formatRow(headers)}\n${rows.map(formatRow).join("\n")}\n`;
};

const addCommand = Command.make("add", {
  ...commandFlags,
  path: Argument.string("path").pipe(Argument.withDescription("Workspace directory path to add.")),
  title: Flag.string("title").pipe(
    Flag.withDescription("Optional project title override."),
    Flag.optional,
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print the result as JSON."),
    Flag.withDefault(false),
  ),
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
        return yield* writeStdout(`${JSON.stringify(result, null, 2)}\n`);
      }

      const verb = result.status === "created" ? "Added" : "Already added";
      return yield* writeStdout(
        `${verb} project "${result.project.title}" (${result.project.workspaceRoot}) [${result.project.id}]\n`,
      );
    }),
  ),
);

const removeCommand = Command.make("remove", {
  ...commandFlags,
  selector: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace path."),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Delete all project threads before removing the project."),
    Flag.withDefault(false),
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print the result as JSON."),
    Flag.withDefault(false),
  ),
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
        return yield* writeStdout(`${JSON.stringify(result, null, 2)}\n`);
      }

      const threadSuffix =
        result.deletedThreadCount > 0
          ? ` and deleted ${result.deletedThreadCount} thread${result.deletedThreadCount === 1 ? "" : "s"}`
          : "";

      return yield* writeStdout(
        `Removed project "${result.project.title}" (${result.project.workspaceRoot})${threadSuffix}.\n`,
      );
    }),
  ),
);

const listCommand = Command.make("list", {
  ...commandFlags,
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print projects as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List projects stored in ace."),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      const projects = yield* runCliProjectCommand(flags, listCliProjects);

      if (json) {
        return yield* writeStdout(`${JSON.stringify(projects, null, 2)}\n`);
      }

      return yield* writeStdout(formatProjectRows(projects));
    }),
  ),
);

export const cli = rootCommand.pipe(
  Command.withSubcommands([addCommand, removeCommand, listCommand]),
);
