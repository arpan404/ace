import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Os from "node:os";
import * as Readline from "node:readline/promises";

import pc from "picocolors";
import QRCode from "qrcode";
import {
  DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM,
  DEFAULT_TERMINAL_ID,
  type TerminalProcessListInput,
  type TerminalProcessSummary,
  type TerminalSessionSnapshot,
  type TerminalTerminateInput,
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
const TelemetryMode = Schema.Literals(["on", "off"]);
type TelemetryMode = typeof TelemetryMode.Type;
const telemetryFlag = Flag.choice("telemetry", TelemetryMode.literals).pipe(
  Flag.withDescription(
    "Set anonymous telemetry mode (`on` or `off`). Root command stores the preference.",
  ),
  Flag.optional,
);
const telemetryModeToEnabled = (mode: TelemetryMode): boolean => mode === "on";
const telemetryEnabledToMode = (enabled: boolean): TelemetryMode => (enabled ? "on" : "off");

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
  telemetryEnabled: Config.boolean("ACE_TELEMETRY_ENABLED").pipe(
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
  readonly telemetry?: Option.Option<TelemetryMode>;
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

const readTelemetryPreference = (preferencePath: string) =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    const raw = yield* Effect.tryPromise(() => fs.readFile(preferencePath, "utf8")).pipe(
      Effect.catch(() => Effect.undefined),
    );
    if (typeof raw !== "string") {
      return undefined;
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.undefined));
    if (parsed === undefined) {
      return undefined;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "enabled" in parsed &&
      typeof parsed.enabled === "boolean"
    ) {
      return parsed.enabled;
    }
    return undefined;
  });

const writeTelemetryPreference = (input: {
  readonly preferencePath: string;
  readonly enabled: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    const path = yield* Effect.promise(() => import("node:path"));
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(input.preferencePath), { recursive: true }),
      catch: (cause) =>
        new DaemonCommandError({
          message: "Failed to create telemetry preference directory.",
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () =>
        fs.writeFile(
          input.preferencePath,
          `${JSON.stringify(
            {
              enabled: input.enabled,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          "utf8",
        ),
      catch: (cause) =>
        new DaemonCommandError({
          message: "Failed to write telemetry preference.",
          cause,
        }),
    });
  });

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
    const persistedTelemetryEnabled = yield* readTelemetryPreference(
      derivedPaths.telemetryPreferencePath,
    );
    const telemetryEnabled = Option.match(flags.telemetry ?? Option.none(), {
      onSome: telemetryModeToEnabled,
      onNone: () =>
        Option.getOrElse(
          Option.fromUndefinedOr(env.telemetryEnabled),
          () => persistedTelemetryEnabled ?? true,
        ),
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
      telemetryEnabled,
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
      telemetryEnabled: false,
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
  telemetry: telemetryFlag,
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
  telemetry: telemetryFlag,
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

const applyTelemetryProcessOverride = (enabled: boolean) =>
  Effect.sync(() => {
    process.env.ACE_TELEMETRY_ENABLED = enabled ? "true" : "false";
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
const allFlag = Flag.boolean("all").pipe(
  Flag.withDescription("Apply the command to every matching item."),
  Flag.withDefault(false),
);
const terminalThreadFlag = Flag.string("thread").pipe(
  Flag.withDescription("Thread id for a terminal process."),
  Flag.optional,
);
const terminalIdFlag = Flag.string("terminal").pipe(
  Flag.withDescription("Terminal id within the thread."),
  Flag.optional,
);

const rootCommandFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  telemetry: telemetryFlag,
  json: jsonFlag,
} as const;

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

type DoctorStatus = "ok" | "warn" | "info";

interface DoctorCheck {
  readonly area: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

interface DoctorCliProbe {
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const doctorCliProbes: ReadonlyArray<DoctorCliProbe> = [
  { label: "Codex", command: "codex", args: ["--version"] },
  { label: "Claude", command: "claude", args: ["--version"] },
  { label: "Cursor", command: "cursor-agent", args: ["--version"] },
  { label: "Gemini", command: "gemini", args: ["--version"] },
  { label: "OpenCode", command: "opencode", args: ["--version"] },
] as const;

const probeCli = (probe: DoctorCliProbe) =>
  Effect.promise(
    () =>
      new Promise<DoctorCheck>((resolve) => {
        const child = ChildProcess.spawn(probe.command, probe.args, {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
          child.kill();
          resolve({
            area: probe.label,
            status: "warn",
            detail: `${probe.command} timed out while checking version`,
          });
        }, 1_500);
        const finish = (check: DoctorCheck) => {
          clearTimeout(timeout);
          resolve(check);
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", () => {
          finish({
            area: probe.label,
            status: "warn",
            detail: `${probe.command} not found on PATH`,
          });
        });
        child.once("exit", (code) => {
          const output = (stdout || stderr).trim().split("\n")[0]?.trim();
          if (code === 0) {
            finish({
              area: probe.label,
              status: "ok",
              detail: output ? `${probe.command}: ${output}` : `${probe.command} available`,
            });
            return;
          }
          finish({
            area: probe.label,
            status: "warn",
            detail: `${probe.command} exited with code ${String(code ?? 0)}`,
          });
        });
      }),
  );

const renderDoctorStatus = (status: DoctorStatus): string => {
  switch (status) {
    case "ok":
      return pc.green(status);
    case "warn":
      return pc.yellow(status);
    case "info":
      return pc.cyan(status);
  }
};

const formatDoctorRows = (checks: ReadonlyArray<DoctorCheck>): string =>
  formatRows(
    ["AREA", "STATUS", "DETAIL"],
    checks.map((check) => [check.area, renderDoctorStatus(check.status), check.detail]),
  );

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

function formatTerminalProcessLabel(process: TerminalProcessSummary): string {
  const title = process.title?.trim() || process.terminalId;
  const pid = process.pid ? `pid ${String(process.pid)}` : process.status;
  return `${title} ${pc.dim(`(${process.threadId}/${process.terminalId}, ${pid})`)}`;
}

function formatTerminalProcessRows(processes: ReadonlyArray<TerminalProcessSummary>): string {
  if (processes.length === 0) {
    return `${pc.dim("No running terminal processes found.")}\n`;
  }
  const headers = ["#", "PID", "THREAD", "TERMINAL", "STATE", "TITLE", "CWD"] as const;
  const rows = processes.map((process, index) => [
    String(index + 1),
    process.pid === null ? "-" : String(process.pid),
    process.threadId,
    process.terminalId,
    process.hasRunningSubprocess ? "busy" : process.status,
    process.title ?? "-",
    process.cwd,
  ]);
  return formatRows(headers, rows);
}

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

type TerminalProcessSelection =
  | { readonly type: "cancel" }
  | { readonly type: "all" }
  | { readonly type: "one"; readonly process: TerminalProcessSummary };

const promptTerminalProcessSelection = (
  processes: ReadonlyArray<TerminalProcessSummary>,
): Effect.Effect<TerminalProcessSelection, DaemonCommandError> =>
  Effect.tryPromise({
    try: async (): Promise<TerminalProcessSelection> => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "Interactive terminal process selection requires a TTY. Pass --thread and --terminal, or use --all.",
        );
      }

      const rl = Readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        process.stdout.write(`${pc.bold("Running terminal processes")}\n`);
        processes.forEach((entry, index) => {
          process.stdout.write(
            `  ${pc.cyan(String(index + 1))}. ${formatTerminalProcessLabel(entry)}\n`,
          );
        });
        process.stdout.write(`  ${pc.cyan("a")}. stop all\n`);
        process.stdout.write(`  ${pc.cyan("c")}. cancel\n`);

        const answer = (await rl.question(`${pc.magenta("›")} `)).trim().toLowerCase();
        if (answer === "c" || answer === "cancel" || answer.length === 0) {
          return { type: "cancel" };
        }
        if (answer === "a" || answer === "all") {
          return { type: "all" };
        }
        const byIndex = Number.parseInt(answer, 10);
        if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= processes.length) {
          const selected = processes[byIndex - 1];
          if (selected) {
            return { type: "one", process: selected };
          }
        }
        throw new Error("Invalid selection. Use a number from the list, a, or c.");
      } finally {
        rl.close();
      }
    },
    catch: (cause) =>
      new DaemonCommandError({
        message: "Failed to read terminal process selection.",
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

interface TerminalWsClient {
  readonly list: (
    input?: TerminalProcessListInput,
  ) => Promise<ReadonlyArray<TerminalProcessSummary>>;
  readonly terminate: (input: TerminalTerminateInput) => Promise<TerminalSessionSnapshot>;
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

async function createTerminalWsClient(wsUrl: string): Promise<TerminalWsClient> {
  const runtime = ManagedRuntime.make(createWsRpcProtocolLayer({ target: normalizeWsUrl(wsUrl) }));
  const scope = runtime.runSync(Scope.make());
  try {
    const client = await withPromiseTimeout({
      timeoutMs: PROFILE_RUNTIME_RPC_CONNECT_TIMEOUT_MS,
      operationLabel: "Connecting to daemon terminal RPC",
      operation: () => runtime.runPromise(Scope.provide(scope)(makeWsRpcProtocolClient)),
    });
    return {
      list: (input = {}) =>
        withPromiseTimeout({
          timeoutMs: PROFILE_RUNTIME_RPC_READ_TIMEOUT_MS,
          operationLabel: "Reading terminal process list",
          operation: () => runtime.runPromise(client[WS_METHODS.terminalList](input)),
        }),
      terminate: (input) =>
        withPromiseTimeout({
          timeoutMs: PROFILE_RUNTIME_RPC_READ_TIMEOUT_MS,
          operationLabel: "Stopping terminal process",
          operation: () =>
            runtime.runPromise(
              client[WS_METHODS.terminalTerminate]({
                ...input,
                terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
              }),
            ),
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

const withTerminalWsClient = <A>(
  flags: CliDataFlags,
  useClient: (client: TerminalWsClient) => Promise<A>,
) =>
  Effect.gen(function* () {
    const connection = yield* resolveLocalDaemonConnection(flags);
    return yield* Effect.tryPromise({
      try: async () => {
        const client = await createTerminalWsClient(connection.wsUrl);
        try {
          return await useClient(client);
        } finally {
          await client.close().catch(() => undefined);
        }
      },
      catch: (cause) =>
        new DaemonCommandError({
          message: "Failed to manage terminal processes.",
          cause,
        }),
    });
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
  daemonArgs.push("--telemetry", input.config.telemetryEnabled ? "on" : "off");

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
  Command.withDescription(
    "Follow the ace daemon in your terminal. Starts the daemon when one is not already running.",
  ),
  Command.withHandler(({ workspaceRoot, ...flags }) =>
    Effect.gen(function* () {
      yield* applyRelayUrlProcessOverride(flags.relayUrl);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, workspaceRoot);
      yield* applyTelemetryProcessOverride(config.telemetryEnabled);
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
  Command.withDescription(
    "Open ace in your browser. Reuses the daemon or starts one in the background.",
  ),
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
      yield* applyTelemetryProcessOverride(config.telemetryEnabled);
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

const runTelemetryPreferenceCommand = (input: {
  readonly flags: CliDataFlags;
  readonly mode: TelemetryMode | "status";
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveDataConfig(input.flags, logLevel);
    if (input.mode !== "status") {
      const enabled = telemetryModeToEnabled(input.mode);
      yield* writeTelemetryPreference({
        preferencePath: config.telemetryPreferencePath,
        enabled,
      });
      if (input.json) {
        return yield* writeJson({
          telemetry: telemetryEnabledToMode(enabled),
          enabled,
          source: "stored-preference",
          path: config.telemetryPreferencePath,
        });
      }
      return yield* writeStdout(
        `${pc.green("Telemetry")} ${telemetryEnabledToMode(enabled)} ${pc.dim(`(${config.telemetryPreferencePath})`)}\n`,
      );
    }

    const stored = yield* readTelemetryPreference(config.telemetryPreferencePath);
    const enabled = stored ?? true;
    const source = stored === undefined ? "default" : "stored-preference";
    if (input.json) {
      return yield* writeJson({
        telemetry: telemetryEnabledToMode(enabled),
        enabled,
        source,
        path: config.telemetryPreferencePath,
      });
    }
    return yield* writeStdout(
      `${pc.bold("Telemetry:")} ${telemetryEnabledToMode(enabled)} ${pc.dim(`source=${source}`)}\n`,
    );
  });

const telemetryActionArgument = Argument.string("action").pipe(
  Argument.withDescription("Telemetry action: status, on, or off."),
  Argument.optional,
);

const resolveTelemetryAction = (
  action: Option.Option<string>,
): Effect.Effect<TelemetryMode | "status", DaemonCommandError> =>
  Effect.gen(function* () {
    if (Option.isNone(action)) {
      return "status";
    }
    const normalized = action.value.trim().toLowerCase();
    if (normalized === "status" || normalized === "on" || normalized === "off") {
      return normalized;
    }
    return yield* new DaemonCommandError({
      message:
        "Unknown telemetry action. Use `ace telemetry status`, `ace telemetry on`, or `ace telemetry off`.",
    });
  });

const telemetryCommand = Command.make("telemetry", {
  ...dataCommandFlags,
  action: telemetryActionArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "View or change the stored anonymous telemetry preference. Defaults to `status`.",
  ),
  Command.withHandler(({ action, json, ...flags }) =>
    Effect.gen(function* () {
      const mode = yield* resolveTelemetryAction(action);
      return yield* runTelemetryPreferenceCommand({
        flags,
        mode,
        json,
      });
    }),
  ),
);

const doctorCommand = Command.make("doctor", {
  ...dataCommandFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Check daemon state, telemetry preference, and provider CLI availability.",
  ),
  Command.withHandler(({ json, ...flags }) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveDataConfig(flags, logLevel);
      const daemon = yield* readDaemonStatusPayload(config.baseDir);
      const telemetryPreference = yield* readTelemetryPreference(config.telemetryPreferencePath);
      const telemetryEnabled = telemetryPreference ?? true;
      const providerChecks = yield* Effect.all(doctorCliProbes.map(probeCli), {
        concurrency: "unbounded",
      });
      const availableProviderCount = providerChecks.filter((check) => check.status === "ok").length;
      const checks: ReadonlyArray<DoctorCheck> = [
        {
          area: "Version",
          status: "info",
          detail: serverPackageVersion,
        },
        {
          area: "Ace home",
          status: "ok",
          detail: config.baseDir,
        },
        {
          area: "Daemon",
          status: daemon.status === "running" ? "ok" : "warn",
          detail:
            daemon.status === "running" && daemon.state
              ? `running pid=${String(daemon.state.pid)} ${daemon.state.wsUrl}`
              : "not running; start with `ace web` or `ace daemon start`",
        },
        {
          area: "Telemetry",
          status: telemetryEnabled ? "info" : "ok",
          detail:
            telemetryPreference === undefined
              ? "on by default; change with `ace telemetry off`"
              : `${telemetryEnabledToMode(telemetryEnabled)} from ${config.telemetryPreferencePath}`,
        },
        {
          area: "Provider CLIs",
          status: availableProviderCount > 0 ? "ok" : "warn",
          detail:
            availableProviderCount > 0
              ? `${String(availableProviderCount)} available on PATH`
              : "no checked provider CLIs found on PATH",
        },
        ...providerChecks,
        {
          area: "Copilot/Pi",
          status: "info",
          detail: "checked through app settings/runtime, not standalone CLI probes",
        },
      ];

      if (json) {
        return yield* writeJson({
          status: checks.some((check) => check.status === "warn") ? "warn" : "ok",
          checks,
        });
      }
      return yield* writeStdout(formatDoctorRows(checks));
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

const terminalListCommand = Command.make("list", {
  ...dataCommandFlags,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List terminal processes owned by the running ace daemon."),
  Command.withHandler((flags) =>
    withTerminalWsClient(flags, (client) => client.list({ runningOnly: !flags.all })).pipe(
      Effect.flatMap((processes) =>
        flags.json ? writeJson(processes) : writeStdout(formatTerminalProcessRows(processes)),
      ),
    ),
  ),
);

const terminalStopCommand = Command.make("stop", {
  ...dataCommandFlags,
  thread: terminalThreadFlag,
  terminal: terminalIdFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withAlias("close"),
  Command.withDescription("Stop terminal processes owned by the running ace daemon."),
  Command.withHandler((flags) =>
    withTerminalWsClient(flags, async (client) => {
      const threadId = Option.getOrUndefined(flags.thread);
      const terminalId = Option.getOrUndefined(flags.terminal) ?? DEFAULT_TERMINAL_ID;

      if (threadId) {
        const stopped = await client.terminate({ threadId, terminalId });
        return { cancelled: false, stopped: [stopped] } as const;
      }

      const processes = await client.list({ runningOnly: true });
      if (processes.length === 0) {
        return { cancelled: false, stopped: [] } as const;
      }

      const selection = flags.all
        ? ({ type: "all" } as const)
        : await Effect.runPromise(promptTerminalProcessSelection(processes));

      if (selection.type === "cancel") {
        return { cancelled: true, stopped: [] } as const;
      }

      const targets = selection.type === "all" ? processes : [selection.process];
      const stopped: TerminalSessionSnapshot[] = [];
      for (const terminalProcess of targets) {
        stopped.push(
          await client.terminate({
            threadId: terminalProcess.threadId,
            terminalId: terminalProcess.terminalId,
          }),
        );
      }
      return { cancelled: false, stopped } as const;
    }).pipe(
      Effect.flatMap((result) => {
        if (flags.json) {
          return writeJson(result);
        }
        if (result.cancelled) {
          return writeStdout(`${pc.dim("Cancelled.")}\n`);
        }
        if (result.stopped.length === 0) {
          return writeStdout(`${pc.dim("No running terminal processes found.")}\n`);
        }
        return writeStdout(
          `${pc.green("Stopped")} ${String(result.stopped.length)} terminal process${
            result.stopped.length === 1 ? "" : "es"
          }.\n`,
        );
      }),
    ),
  ),
);

const terminalCommand = Command.make("terminal").pipe(
  Command.withAlias("terminals"),
  Command.withDescription("List and stop terminal processes owned by ace."),
  Command.withSubcommands([terminalListCommand, terminalStopCommand]),
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
  Command.withDescription("Pair this machine with another device and manage saved remote hosts."),
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
  Command.withDescription("Start the background ace daemon. Safe to run more than once."),
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
      yield* applyTelemetryProcessOverride(config.telemetryEnabled);
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
      yield* applyTelemetryProcessOverride(config.telemetryEnabled);

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
  Command.withDescription(
    "Show whether the background daemon is running and where it is listening.",
  ),
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

const runDaemonStopCommand = (input: {
  readonly timeoutMs: number;
  readonly json: boolean;
  readonly flags: CliDataFlags;
}) =>
  runDaemonCommand(
    input.flags,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const result = yield* stopDaemonIfPresent({
        baseDir: config.baseDir,
        timeoutMs: input.timeoutMs,
      });
      if (input.json) {
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
  Command.withDescription("Gracefully stop the background daemon."),
  Command.withHandler(({ timeoutMs, json, ...flags }) =>
    runDaemonStopCommand({ timeoutMs, json, flags }),
  ),
);

const stopCommand = Command.make("stop", {
  ...dataCommandFlags,
  timeoutMs: Flag.integer("timeout-ms").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(250))),
    Flag.withDescription("How long to wait for graceful daemon shutdown."),
    Flag.withDefault(8_000),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Gracefully stop the background daemon."),
  Command.withHandler(({ timeoutMs, json, ...flags }) =>
    runDaemonStopCommand({ timeoutMs, json, flags }),
  ),
);

const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription(
    "Manage the background server used by the web app and provider sessions.",
  ),
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

export const formatRootCliGuide = (): string =>
  [
    `${pc.bold("ace CLI")}`,
    pc.dim("Run coding agents through a local daemon and web UI."),
    "",
    `${pc.bold("Start")}`,
    `  ${pc.cyan("ace web [workspace]")}              open ace now`,
    `  ${pc.cyan("ace serve [workspace]")}            follow daemon logs`,
    `  ${pc.cyan("ace doctor")}                       check local setup`,
    `  ${pc.cyan("ace interactive")}                  pick an action`,
    "",
    `${pc.bold("Daemon")}`,
    `  ${pc.cyan("ace daemon status")}                inspect background server`,
    `  ${pc.cyan("ace daemon start")}                 start it explicitly`,
    `  ${pc.cyan("ace stop")}                         stop it`,
    `  ${pc.cyan("ace daemon restart")}               restart it`,
    "",
    `${pc.bold("Settings")}`,
    `  ${pc.cyan("ace telemetry status")}             show telemetry setting`,
    `  ${pc.cyan("ace telemetry off")}                disable telemetry by default`,
    `  ${pc.cyan("ace web --telemetry off")}          disable telemetry for one run`,
    "",
    `${pc.bold("Data and remotes")}`,
    `  ${pc.cyan("ace project list")}                 list saved projects`,
    `  ${pc.cyan("ace terminal list")}                list running terminal processes`,
    `  ${pc.cyan('ace remote create --device-name="Macbook Pro"')}  pair another device`,
    `  ${pc.cyan("ace remote list")}                  list paired devices`,
    "",
    `${pc.bold("Reference")}`,
    `  ${pc.cyan("ace --help")}                       full command reference`,
    `  ${pc.cyan("ace <command> --help")}             command-specific flags`,
  ].join("\n");

const helpSection = (title: string, lines: ReadonlyArray<string>): string =>
  [`${pc.bold(title)}`, ...lines.map((line) => `  ${line}`)].join("\n");

const helpCommand = (command: string, description: string): string =>
  `${pc.cyan(command.padEnd(46))}${description}`;

const helpFlag = (flag: string, description: string): string =>
  `${pc.cyan(flag.padEnd(30))}${description}`;

const formatHelpPage = (input: {
  readonly title: string;
  readonly summary: string;
  readonly usage: string;
  readonly sections: ReadonlyArray<string>;
}): string =>
  [
    `${pc.bold(input.title)}`,
    input.summary,
    "",
    helpSection("Usage", [pc.cyan(input.usage)]),
    "",
    ...input.sections.flatMap((section) => [section, ""]),
  ].join("\n");

const rootHelpSections = [
  helpSection("Start Here", [
    helpCommand("ace web [workspace]", "open ace now"),
    helpCommand("ace doctor", "check daemon, telemetry, and provider CLIs"),
    helpCommand("ace interactive", "pick an action from a short menu"),
  ]),
  helpSection("Daemon", [
    helpCommand("ace daemon status", "show background server status"),
    helpCommand("ace daemon start", "start the daemon explicitly"),
    helpCommand("ace stop", "stop the daemon"),
    helpCommand("ace daemon restart", "restart daemon with existing settings"),
  ]),
  helpSection("Settings", [
    helpCommand("ace telemetry", "show telemetry preference"),
    helpCommand("ace telemetry off", "disable telemetry by default"),
    helpCommand("ace --telemetry off", "same persistent shortcut"),
    helpCommand("ace web --telemetry off", "disable telemetry for one run"),
  ]),
  helpSection("Data and Remotes", [
    helpCommand("ace project list", "list saved projects"),
    helpCommand("ace terminal list", "list running terminal processes"),
    helpCommand('ace remote create --device-name "Macbook Pro"', "pair another device"),
    helpCommand("ace remote list", "list paired devices"),
  ]),
  helpSection("Global Flags", [
    helpFlag("--help, -h", "show help"),
    helpFlag("--version", "show version"),
    helpFlag("--log-level <level>", "all, trace, debug, info, warn, error, fatal, none"),
    helpFlag("--base-dir <path>", "override ace home for config/state commands"),
    helpFlag("--json", "machine-readable output where supported"),
  ]),
] as const;

const commandHelpPages: Record<string, string> = {
  root: formatHelpPage({
    title: "ace CLI",
    summary: "Run coding agents through a local daemon and web UI.",
    usage: "ace <command> [flags]",
    sections: rootHelpSections,
  }),
  web: formatHelpPage({
    title: "ace web",
    summary: "Open ace in your browser. Reuses the daemon or starts one in the background.",
    usage: "ace web [workspace] [flags]",
    sections: [
      helpSection("Examples", [
        helpCommand("ace web", "open ace"),
        helpCommand("ace web .", "open ace and add the current workspace"),
        helpCommand("ace web --telemetry off", "disable telemetry for this run"),
        helpCommand("ace web --no-browser", "start daemon without opening browser"),
      ]),
      helpSection("Useful Flags", [
        helpFlag("--port <number>", "server port"),
        helpFlag("--host <host>", "bind address"),
        helpFlag("--base-dir <path>", "ace state directory"),
        helpFlag("--telemetry on|off", "one-run telemetry override"),
      ]),
    ],
  }),
  serve: formatHelpPage({
    title: "ace serve",
    summary: "Follow daemon logs in your terminal. Starts the daemon when one is not running.",
    usage: "ace serve [workspace] [flags]",
    sections: [
      helpSection("Examples", [
        helpCommand("ace serve", "attach to daemon logs"),
        helpCommand("ace serve .", "start/follow daemon for current workspace"),
      ]),
      helpSection("Useful Flags", [
        helpFlag("--port <number>", "server port"),
        helpFlag("--host <host>", "bind address"),
        helpFlag("--telemetry on|off", "one-run telemetry override"),
      ]),
    ],
  }),
  doctor: formatHelpPage({
    title: "ace doctor",
    summary: "Check daemon state, telemetry preference, and provider CLI availability.",
    usage: "ace doctor [flags]",
    sections: [
      helpSection("Examples", [
        helpCommand("ace doctor", "human-readable setup report"),
        helpCommand("ace doctor --json", "machine-readable setup report"),
      ]),
      helpSection("Checks", [
        "ace version and home directory",
        "daemon running/listening state",
        "stored telemetry preference",
        "Codex, Claude, Cursor, Gemini, and OpenCode CLI availability",
      ]),
    ],
  }),
  telemetry: formatHelpPage({
    title: "ace telemetry",
    summary: "View or change the stored anonymous telemetry preference.",
    usage: "ace telemetry [status|on|off] [flags]",
    sections: [
      helpSection("Examples", [
        helpCommand("ace telemetry", "show current preference"),
        helpCommand("ace telemetry status", "show current preference"),
        helpCommand("ace telemetry off", "disable telemetry by default"),
        helpCommand("ace telemetry on", "enable telemetry by default"),
        helpCommand("ace --telemetry off", "persistent shortcut"),
      ]),
      helpSection("Precedence", [
        "1. command flag: --telemetry on|off",
        "2. environment: ACE_TELEMETRY_ENABLED",
        "3. stored preference: ace telemetry on|off",
        "4. default: on",
      ]),
    ],
  }),
  daemon: formatHelpPage({
    title: "ace daemon",
    summary: "Manage the background server used by the web app and provider sessions.",
    usage: "ace daemon <start|status|stop|restart> [flags]",
    sections: [
      helpSection("Commands", [
        helpCommand("ace daemon start", "start daemon, safe to run more than once"),
        helpCommand("ace daemon status", "show pid, URL, version, and health"),
        helpCommand("ace daemon stop", "gracefully stop daemon"),
        helpCommand("ace daemon restart", "restart daemon with existing settings"),
        helpCommand("ace stop", "top-level stop shortcut"),
      ]),
      helpSection("Automation", [
        helpCommand("ace daemon status --json", "read status in scripts"),
        helpCommand("ace stop --json", "stop daemon in scripts"),
      ]),
    ],
  }),
  stop: formatHelpPage({
    title: "ace stop",
    summary: "Gracefully stop the background daemon. Same behavior as `ace daemon stop`.",
    usage: "ace stop [flags]",
    sections: [
      helpSection("Examples", [
        helpCommand("ace stop", "stop daemon"),
        helpCommand("ace stop --json", "machine-readable result"),
      ]),
    ],
  }),
  project: formatHelpPage({
    title: "ace project",
    summary: "Manage saved local projects without launching the server runtime.",
    usage: "ace project <add|list|remove> [flags]",
    sections: [
      helpSection("Commands", [
        helpCommand("ace project add <path>", "save a workspace"),
        helpCommand("ace project list", "list saved workspaces"),
        helpCommand("ace project remove <project>", "remove by id, title, or path"),
      ]),
    ],
  }),
  terminal: formatHelpPage({
    title: "ace terminal",
    summary: "List and stop terminal processes owned by the running ace daemon.",
    usage: "ace terminal <list|stop> [flags]",
    sections: [
      helpSection("Commands", [
        helpCommand("ace terminal list", "list running terminal processes"),
        helpCommand("ace terminal stop", "choose a terminal process to stop"),
        helpCommand("ace terminal stop --all", "stop every running terminal process"),
      ]),
      helpSection("Selectors", [
        helpFlag("--thread <id>", "target a specific thread"),
        helpFlag("--terminal <id>", "target a terminal within the thread"),
        helpFlag("--json", "machine-readable output"),
      ]),
    ],
  }),
  remote: formatHelpPage({
    title: "ace remote",
    summary: "Pair this machine with another device and manage saved remote hosts.",
    usage: "ace remote <create|list|link|revoke|remove|ping> [flags]",
    sections: [
      helpSection("Pair Another Device", [
        helpCommand('ace remote create --device-name "Macbook Pro"', "show token and QR"),
        helpCommand("ace remote list", "list pairing sessions"),
        helpCommand("ace remote revoke <session>", "revoke a pairing session"),
      ]),
      helpSection("Connect To A Host", [
        helpCommand("ace remote link --token <token>", "save a remote host"),
        helpCommand("ace remote ping --once", "check saved remotes once"),
        helpCommand("ace remote remove <remote>", "remove a saved remote"),
      ]),
    ],
  }),
} as const;

export const formatCliHelp = (args: ReadonlyArray<string>): string | null => {
  const helpRequested = args.includes("--help") || args.includes("-h") || args[0] === "help";
  if (!helpRequested) {
    return null;
  }
  const positional =
    args[0] === "help" ? args.slice(1) : args.filter((arg) => arg !== "--help" && arg !== "-h");
  const topic = positional[0] ?? "root";
  if (topic === "projects") {
    return commandHelpPages.project ?? null;
  }
  return commandHelpPages[topic] ?? null;
};

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
  "doctor",
  "update",
  "daemon-status",
  "daemon-stop",
  "daemon-restart",
  "telemetry-status",
  "telemetry-off",
  "project-list",
  "terminal-list",
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
  doctor: {
    description: "Check local setup",
    argv: ["doctor"],
  },
  update: {
    description: "Update packaged desktop app",
    argv: ["update"],
  },
  "daemon-status": {
    description: "Show daemon status",
    argv: ["daemon", "status"],
  },
  "daemon-stop": {
    description: "Stop daemon",
    argv: ["stop"],
  },
  "daemon-restart": {
    description: "Restart daemon",
    argv: ["daemon", "restart"],
  },
  "telemetry-status": {
    description: "Show telemetry setting",
    argv: ["telemetry", "status"],
  },
  "telemetry-off": {
    description: "Disable telemetry by default",
    argv: ["telemetry", "off"],
  },
  "project-list": {
    description: "List saved projects",
    argv: ["project", "list"],
  },
  "terminal-list": {
    description: "List running terminal processes",
    argv: ["terminal", "list"],
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

const rootCommand = Command.make("ace", rootCommandFlags).pipe(
  Command.withDescription(
    [
      "ace CLI. Open the web app, manage the local daemon, pair devices, and control telemetry.",
      "",
      "Common flows:",
      "  ace web [workspace]          open ace now",
      "  ace doctor                   check local setup",
      "  ace stop                     stop the daemon",
      "  ace telemetry off            disable telemetry by default",
      "  ace interactive              pick an action",
    ].join("\n"),
  ),
  Command.withHandler(({ telemetry, json, ...flags }) =>
    Effect.gen(function* () {
      if (Option.isSome(telemetry)) {
        return yield* runTelemetryPreferenceCommand({
          flags,
          mode: telemetry.value,
          json,
        });
      }
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
    doctorCommand,
    updateCommand,
    profileCommand,
    telemetryCommand,
    projectCommand,
    terminalCommand,
    remoteCommand,
    daemonCommand,
    stopCommand,
    interactiveCommand,
  ]),
);
