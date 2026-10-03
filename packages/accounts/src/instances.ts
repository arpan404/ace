import { opendir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { discoverProvider, type DiscoveryOptions } from "@ace/provider-kit/discovery";
import { ProviderInstance, type NativeAccountProvider } from "@ace/protocol/accounts";
import type { z } from "zod";

type Provider = z.infer<typeof NativeAccountProvider>;
export function createInstance(input: {
  id: string;
  provider: ProviderInstance["provider"];
  label: string;
  homeDir: string;
}): ProviderInstance {
  if (input.provider === "acp")
    throw new Error(
      "ACP account isolation is unsupported; use createAcpInstance for the CLI default",
    );
  const homeDir = resolve(input.homeDir);
  const env: ProviderInstance["env"] =
    input.provider === "codex"
      ? { CODEX_HOME: homeDir }
      : input.provider === "claude"
        ? { CLAUDE_CONFIG_DIR: homeDir }
        : input.provider === "cursor"
          ? { CURSOR_DATA_DIR: homeDir }
          : {
              XDG_DATA_HOME: join(homeDir, "data"),
              XDG_CONFIG_HOME: join(homeDir, "config"),
              XDG_STATE_HOME: join(homeDir, "state"),
              XDG_CACHE_HOME: join(homeDir, "cache"),
            };
  return ProviderInstance.parse({ ...input, homeDir, env });
}

const authOverrides = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "OPENCODE_DB",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
/** Undefined masks the ambient variable when provider-kit merges process.env. */
export function instanceEnv(
  instance: ProviderInstance,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const parsed = ProviderInstance.parse(instance);
  if (parsed.provider === "acp") return { ...base };
  const allowed =
    parsed.provider === "codex"
      ? ["CODEX_HOME"]
      : parsed.provider === "claude"
        ? ["CLAUDE_CONFIG_DIR"]
        : parsed.provider === "cursor"
          ? ["CURSOR_DATA_DIR"]
          : ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
  if (Object.keys(parsed.env).some((key) => !allowed.includes(key)))
    throw new Error("Conflicting instance environment");
  const expected = createInstance(parsed).env;
  if (parsed.provider !== "opencode" && JSON.stringify(parsed.env) !== JSON.stringify(expected))
    throw new Error("Instance home selector mismatch");
  if (parsed.provider === "opencode" && (!parsed.env.XDG_DATA_HOME || !parsed.env.XDG_CONFIG_HOME))
    throw new Error("OpenCode requires data and config roots");
  const env = { ...base };
  for (const key of authOverrides) env[key] = undefined;
  // Cursor has a separate documented configuration override; keep it on the same home.
  if (parsed.provider === "cursor") {
    env["CURSOR_CONFIG_DIR"] = parsed.homeDir;
    // The CLI's default macOS keychain is global. Its native file store follows
    // HOME/XDG_CONFIG_HOME instead of CURSOR_DATA_DIR; the CLI owns auth entry.
    env["AGENT_CLI_CREDENTIAL_STORE"] = "file";
    env["HOME"] = join(parsed.homeDir, "user");
    env["USERPROFILE"] = join(parsed.homeDir, "user");
    env["APPDATA"] = join(parsed.homeDir, "appdata");
    env["XDG_CONFIG_HOME"] = join(parsed.homeDir, "config");
  }
  return { ...env, ...parsed.env };
}
export async function loginStatus(instance: ProviderInstance, options: DiscoveryOptions = {}) {
  if (instance.provider === "acp")
    return {
      installed: false,
      auth: "unknown" as const,
      loginHint: "Use the selected agent’s own CLI login",
      error: "ACP login status is unverified",
    };
  const result = await discoverProvider(instance.provider, {
    ...options,
    env: instanceEnv(instance, options.env ?? process.env),
  });
  // This credential-store selector is hidden, so do not trust unknown releases
  // to isolate auth merely because they accept data/config directory variables.
  if (instance.provider === "cursor" && result.version !== "2026.09.26-dd393fe")
    return {
      ...result,
      auth: "unknown" as const,
      error: "Cursor account isolation is not verified for this CLI version",
    };
  return result;
}
export function loginArgs(
  provider: Provider,
  mode: "subscription" | "api" = "subscription",
): string[] {
  if (provider === "codex") {
    if (mode === "api")
      throw new Error("Use codex login --with-api-key directly; ace never accepts keys");
    return ["login"];
  }
  if (provider === "claude") return ["auth", "login", mode === "api" ? "--console" : "--claudeai"];
  return provider === "cursor" ? ["login"] : ["auth", "login"];
}

/** Conventional homes only; no auth files, no recursion, capped inventory. */
export async function discoverHomes(userHome: string): Promise<ProviderInstance[]> {
  const results: ProviderInstance[] = [];
  const directory = await opendir(userHome);
  for await (const entry of directory) {
    if (results.length >= 256) break;
    if (!entry.isDirectory()) continue;
    const match = /^\.(codex|claude|cursor|opencode)(?:[-_][\w.-]+)?$/.exec(entry.name);
    if (!match) continue;
    const provider = match[1];
    if (
      provider !== "codex" &&
      provider !== "claude" &&
      provider !== "cursor" &&
      provider !== "opencode"
    )
      continue;
    const home = join(userHome, entry.name);
    if (
      entry.name.length > 128 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.name.slice(1).replaceAll(".", "_"))
    )
      continue;
    results.push(
      createInstance({
        id: entry.name.slice(1).replaceAll(".", "_"),
        provider,
        label: basename(home),
        homeDir: home,
      }),
    );
  }
  // OpenCode's normal XDG roots differ from ace-created bundled roots.
  const data = join(userHome, ".local", "share");
  try {
    const dirs = await opendir(join(data, "opencode"));
    await dirs.close();
    if (results.length < 256)
      results.push(
        ProviderInstance.parse({
          id: "opencode-default",
          provider: "opencode",
          label: "OpenCode default",
          homeDir: join(data, "opencode"),
          env: {
            XDG_DATA_HOME: data,
            XDG_CONFIG_HOME: join(userHome, ".config"),
            XDG_STATE_HOME: join(userHome, ".local", "state"),
            XDG_CACHE_HOME: join(userHome, ".cache"),
          },
        }),
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return results;
}
