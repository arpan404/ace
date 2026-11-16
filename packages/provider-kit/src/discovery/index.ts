import { findOpenCodeExecutable } from "./opencode-executable.ts";
export { findOpenCodeExecutable } from "./opencode-executable.ts";
import { findExecutable } from "./executable.ts";
export { findExecutable, isPackageRunner, scriptExecutablePaths } from "./executable.ts";
export { findWindowsExecutableSync } from "./executable.ts";
import { z } from "zod";
import { checkCli } from "../cli-requirements.ts";
import { probeOutput } from "../process.ts";
import {
  parseClaudeAuth,
  parseCodexAuth,
  parseOpenCodeAuth,
  parseVersion,
  type AuthStatus,
} from "./parsers.ts";
export {
  parseOpenCodeAuthConnections,
  parseClaudeAuth,
  parseCodexAuth,
  parseOpenCodeAuth,
  parseVersion,
} from "./parsers.ts";
export type { AuthStatus } from "./parsers.ts";

const ProviderSchema = z.enum(["claude", "codex", "opencode", "cursor"]);
export type Provider = "claude" | "codex" | "opencode" | "cursor";
export type { DiscoveryResult } from "./types.ts";
import type { DiscoveryResult } from "./types.ts";
export type DiscoveryOptions = {
  overrides?: Partial<Record<Provider, string>>;
  /** Explicit environment overrides, including PATH, for resolution and probes. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  probe?: typeof probeOutput;
};
const specs = {
  claude: {
    command: "claude",
    authArgs: ["auth", "status"],
    parse: parseClaudeAuth,
    loginHint: "claude auth login",
  },
  codex: {
    command: "codex",
    authArgs: ["login", "status"],
    parse: parseCodexAuth,
    loginHint: "codex login",
  },
  opencode: {
    command: "opencode",
    authArgs: ["auth", "list", "--standalone", "--format", "json"],
    parse: parseOpenCodeAuth,
    loginHint: "opencode auth login",
  },
} satisfies Record<
  Exclude<Provider, "cursor">,
  { command: string; authArgs: string[]; parse: (text: string) => AuthStatus; loginHint: string }
>;

/** The installed CLI command to restore when a user removes an executable override. */
export function defaultProviderExecutable(provider: Provider | "pi" | "antigravity"): string {
  if (provider === "pi") return "pi";
  if (provider === "antigravity") return "agy_acp_server";
  if (provider === "cursor") return "";
  return specs[provider].command;
}

function probeError(label: string, error: unknown): string {
  // Exception messages and CLI stderr can contain credentials or identities.
  return error instanceof Error && error.message === "Probe timed out"
    ? `${label} timed out`
    : `${label} failed`;
}

/** Probe only the requested CLI, without inspecting other providers' accounts. */
export async function discoverProvider(
  input: Provider,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  return (await locateProvider(input, options)).discovered;
}

/**
 * The same probes as `discoverProvider`, answered in two stages. `located` comes as soon as the
 * CLI's path and version are read, with its login still `unknown`: enough to register an
 * adapter. `discovered` is the full result, login included, which can take far longer (OpenCode
 * reads its login status for most of a second).
 */
export async function locateProvider(
  input: Provider,
  options: DiscoveryOptions = {},
): Promise<{ located: DiscoveryResult; discovered: Promise<DiscoveryResult> }> {
  options.signal?.throwIfAborted();
  const provider = ProviderSchema.parse(input);
  if (provider === "cursor") {
    const absent = { installed: false, auth: "unknown" as const, loginHint: "Sign in to Cursor" };
    return { located: absent, discovered: Promise.resolve({ ...absent }) };
  }
  const env = { ...process.env, ...options.env };
  const spec = specs[provider];
  const result: DiscoveryResult = {
    installed: false,
    auth: "unknown",
    loginHint: spec.loginHint,
  };
  const command = options.overrides?.[provider] ?? spec.command;
  const opencode =
    provider === "opencode"
      ? await findOpenCodeExecutable(command, { ...options, env })
      : undefined;
  const path = provider === "opencode" ? opencode?.path : await findExecutable(command, env);
  options.signal?.throwIfAborted();
  if (!path) return { located: result, discovered: Promise.resolve({ ...result }) };
  result.installed = true;
  result.path = path;
  const probeOptions = {
    env,
    timeoutMs: options.timeoutMs ?? 10_000,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const auth = settle((options.probe ?? probeOutput)(path, spec.authArgs, probeOptions));
  const version = await settle(
    opencode
      ? Promise.resolve({ code: 0, stdout: opencode.version, stderr: "" })
      : (options.probe ?? probeOutput)(path, ["--version"], probeOptions),
  );
  options.signal?.throwIfAborted();
  const versionErrors: string[] = [];
  if (version.status === "fulfilled" && version.value.code === 0) {
    const parsed = parseVersion(provider, version.value.stdout);
    if (parsed) result.version = parsed;
    else versionErrors.push("Unrecognized version output");
  } else
    versionErrors.push(
      version.status === "rejected"
        ? probeError("Version probe", version.reason)
        : "Version probe exited unsuccessfully",
    );
  result.versionCheck = checkCli(provider, result.version);
  const located: DiscoveryResult = { ...result };
  if (versionErrors.length) located.error = versionErrors.join("; ");
  const discovered = auth.then((reading) => {
    options.signal?.throwIfAborted();
    const full: DiscoveryResult = { ...result };
    const errors = [...versionErrors];
    if (reading.status === "fulfilled") {
      const parsed = spec.parse(reading.value.stdout || reading.value.stderr);
      if (reading.value.code === 0 || (reading.value.code === 1 && parsed.auth === "logged_out"))
        Object.assign(full, parsed);
      if (full.auth === "unknown" && full.authEvidence !== "credentials_configured")
        errors.push(
          reading.value.code === 0
            ? "Unrecognized auth status output"
            : "Authentication probe exited unsuccessfully",
        );
    } else errors.push(probeError("Authentication probe", reading.reason));
    if (errors.length) full.error = errors.join("; ");
    return full;
  });
  return { located, discovered };
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

export async function discoverProviders(
  options: DiscoveryOptions = {},
): Promise<Record<Provider, DiscoveryResult>> {
  const [claude, codex, opencode, cursor] = await Promise.all([
    discoverProvider("claude", options),
    discoverProvider("codex", options),
    discoverProvider("opencode", options),
    Promise.resolve({ installed: false, auth: "unknown" as const, loginHint: "Sign in to Cursor" }),
  ]);
  return { claude, codex, opencode, cursor };
}

/** No documented read-only login-status command: never enter the interactive login flow. */
export async function discoverAntigravity(
  options: DiscoveryOptions & { executable?: string } = {},
): Promise<DiscoveryResult> {
  const env = { ...process.env, ...options.env };
  const path = await findExecutable(options.executable ?? "agy_acp_server", env);
  const result: DiscoveryResult = {
    installed: Boolean(path),
    auth: "unknown",
    loginHint: "Sign in using Antigravity’s own ACP authentication",
  };
  if (!path) return result;
  result.path = path;
  try {
    const output = await (options.probe ?? probeOutput)(path, ["--version"], {
      env,
      timeoutMs: options.timeoutMs ?? 4000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (output.code === 0) {
      const version = parseVersion("antigravity", output.stdout);
      if (version) result.version = version;
    }
  } catch {
    /* Status stays unknown; raw exceptions and CLI output are private. */
  }
  result.versionCheck = checkCli("antigravity", result.version);
  result.error =
    "Login status requires interactive verification; no safe status command is documented";
  return result;
}

export { discoverPi } from "./pi.ts";
export { startupProbes, type StartupProbes } from "./startup-probes.ts";
export { discoverPiStatus } from "./pi-status.ts";
export { piSdkEntry, piCredentialProviders, PiProviderId } from "./pi-sdk.ts";
export {
  discoverDescriptor,
  type DiscoveryDescriptor,
  type DescriptorOptions,
} from "./descriptor.ts";
