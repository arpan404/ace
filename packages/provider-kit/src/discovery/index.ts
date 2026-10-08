import { findExecutable } from "./executable.ts";
export { findExecutable, isPackageRunner, scriptExecutablePaths } from "./executable.ts";
import { z } from "zod";
import { probeOutput } from "../process.ts";
import {
  parseClaudeAuth,
  parseCodexAuth,
  parseOpenCodeAuth,
  parseVersion,
  type AuthStatus,
} from "./parsers.ts";
export { parseClaudeAuth, parseCodexAuth, parseOpenCodeAuth, parseVersion } from "./parsers.ts";
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
    loginHint: "claude, then /login",
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
  if (provider === "antigravity") return "agy";
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
  options.signal?.throwIfAborted();
  const provider = ProviderSchema.parse(input);
  if (provider === "cursor")
    return { installed: false, auth: "unknown", loginHint: "Sign in to Cursor" };
  const env = { ...process.env, ...options.env };
  const spec = specs[provider];
  const result: DiscoveryResult = {
    installed: false,
    auth: "unknown",
    loginHint: spec.loginHint,
  };
  const path = await findExecutable(options.overrides?.[provider] ?? spec.command, env);
  options.signal?.throwIfAborted();
  if (!path) return result;
  result.installed = true;
  result.path = path;
  const probeOptions = {
    env,
    timeoutMs: options.timeoutMs ?? 10_000,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const [version, auth] = await Promise.allSettled([
    (options.probe ?? probeOutput)(path, ["--version"], probeOptions),
    (options.probe ?? probeOutput)(path, spec.authArgs, probeOptions),
  ]);
  options.signal?.throwIfAborted();
  const errors: string[] = [];
  if (version.status === "fulfilled" && version.value.code === 0) {
    const parsed = parseVersion(provider, version.value.stdout);
    if (parsed) result.version = parsed;
    else errors.push("Unrecognized version output");
  } else
    errors.push(
      version.status === "rejected"
        ? probeError("Version probe", version.reason)
        : "Version probe exited unsuccessfully",
    );
  if (auth.status === "fulfilled") {
    const parsed = spec.parse(auth.value.stdout || auth.value.stderr);
    if (auth.value.code === 0 || (auth.value.code === 1 && parsed.auth === "logged_out"))
      Object.assign(result, parsed);
    if (result.auth === "unknown")
      errors.push(
        auth.value.code === 0
          ? "Unrecognized auth status output"
          : "Authentication probe exited unsuccessfully",
      );
  } else errors.push(probeError("Authentication probe", auth.reason));
  if (errors.length) result.error = errors.join("; ");
  return result;
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
  const path = await findExecutable(options.executable ?? "agy", env);
  const result: DiscoveryResult = {
    installed: Boolean(path),
    auth: "unknown",
    loginHint: "agy interactively to verify your Google account login",
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
  result.error =
    "Login status requires interactive verification; no safe status command is documented";
  return result;
}

export { discoverPi } from "./pi.ts";
export { discoverPiStatus } from "./pi-status.ts";
export {
  discoverDescriptor,
  type DiscoveryDescriptor,
  type DescriptorOptions,
} from "./descriptor.ts";
