import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { probeOutput } from "../process.ts";
import {
  parseClaudeAuth,
  parseCodexAuth,
  parseCursorAuth,
  parseOpenCodeAuth,
  parseVersion,
  type AuthStatus,
} from "./parsers.ts";
export {
  parseClaudeAuth,
  parseCodexAuth,
  parseCursorAuth,
  parseOpenCodeAuth,
  parseVersion,
} from "./parsers.ts";
export type { AuthStatus } from "./parsers.ts";

export type Provider = "claude" | "codex" | "opencode" | "cursor";
export type DiscoveryResult = AuthStatus & {
  installed: boolean;
  path?: string;
  version?: string;
  loginHint: string;
  error?: string;
};
export type DiscoveryOptions = {
  overrides?: Partial<Record<Provider, string>>;
  /** Explicit environment overrides, including PATH, for resolution and probes. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    authArgs: ["auth", "list"],
    parse: parseOpenCodeAuth,
    loginHint: "opencode auth login",
  },
  cursor: {
    command: "agent",
    authArgs: ["status"],
    parse: parseCursorAuth,
    loginHint: "agent login",
  },
} satisfies Record<
  Provider,
  { command: string; authArgs: string[]; parse: (text: string) => AuthStatus; loginHint: string }
>;

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve directly, without a shell or a platform-specific `which` subprocess. */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const path = resolve(command);
    return (await executable(path)) ? path : undefined;
  }
  const candidates = (env["PATH"] ?? "")
    .split(delimiter)
    .map((directory) => resolve(directory, command));
  const found = await Promise.all(candidates.map(executable));
  return candidates.find((_, index) => found[index]);
}

function probeError(label: string, error: unknown): string {
  // Exception messages and CLI stderr can contain credentials or identities.
  return error instanceof Error && error.message === "Probe timed out"
    ? `${label} timed out`
    : `${label} failed`;
}

export async function discoverProviders(
  options: DiscoveryOptions = {},
): Promise<Record<Provider, DiscoveryResult>> {
  const env = { ...process.env, ...options.env };
  const entries = await Promise.all(
    (Object.keys(specs) as Provider[]).map(
      async (provider): Promise<[Provider, DiscoveryResult]> => {
        const spec = specs[provider];
        const result: DiscoveryResult = {
          installed: false,
          auth: "unknown",
          loginHint: spec.loginHint,
        };
        const path = await findExecutable(options.overrides?.[provider] ?? spec.command, env);
        if (!path) return [provider, result];
        result.installed = true;
        result.path = path;
        const probeOptions = {
          env,
          timeoutMs: options.timeoutMs ?? 10_000,
          ...(options.signal ? { signal: options.signal } : {}),
        };
        const [version, auth] = await Promise.allSettled([
          probeOutput(path, ["--version"], probeOptions),
          probeOutput(path, spec.authArgs, probeOptions),
        ]);
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
          Object.assign(result, spec.parse(auth.value.stdout || auth.value.stderr));
          if (result.auth === "unknown")
            errors.push(
              auth.value.code === 0
                ? "Unrecognized auth status output"
                : "Authentication probe exited unsuccessfully",
            );
        } else errors.push(probeError("Authentication probe", auth.reason));
        if (errors.length) result.error = errors.join("; ");
        return [provider, result];
      },
    ),
  );
  return Object.fromEntries(entries) as Record<Provider, DiscoveryResult>;
}

/** No documented read-only login-status command: never enter the interactive login flow. */
export async function discoverAntigravity(
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const env = options.env ?? process.env;
  const path = await findExecutable("agy", env);
  const result: DiscoveryResult = {
    installed: Boolean(path),
    auth: "unknown",
    loginHint: "agy interactively to verify your Google account login",
  };
  if (!path) return result;
  result.path = path;
  try {
    const output = await probeOutput(path, ["--version"], {
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
