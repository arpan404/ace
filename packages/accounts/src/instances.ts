import { cursorSdkEnvironment } from "@ace/adapter-cursor/instance";
import { openCodeAuthArgs } from "./opencode-auth.ts";
import { ghConfigDir } from "@ace/provider-kit/user-tool-paths";
import { opendir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  discoverProvider,
  discoverPiStatus,
  type DiscoveryOptions,
} from "@ace/provider-kit/discovery";
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
        : input.provider === "pi"
          ? { PI_CODING_AGENT_DIR: homeDir }
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
  // Claude reads its login from this folder ahead of CLAUDE_CONFIG_DIR; an empty value
  // selects the person's own default login.
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
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
/**
 * Only the selectors that hold the CLI's own login and settings move to the account home.
 * HOME, APPDATA and TMPDIR stay the person's, so gh, git, ssh, npm and the keychain work
 * inside an account exactly as they do in a terminal. Each CLI keys its credentials on its
 * selector (Claude's keychain entry name hashes CLAUDE_CONFIG_DIR, Codex and Pi keep
 * `auth.json` in their home), so accounts stay apart without a private HOME. Cursor's SDK
 * reads `os.homedir()` and is the one exception; see `cursorSdkEnvironment`.
 */
function appliedSelectors(
  instance: ProviderInstance,
  person: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (instance.provider !== "opencode") return instance.env;
  // OpenCode keeps its login under XDG_DATA_HOME, finds its background service (which
  // serves that login) through XDG_STATE_HOME, and reads provider keys from its config
  // under XDG_CONFIG_HOME, so all three move. Its cache stays the person's. gh would follow
  // the moved config root, so it is pointed back at the person's own.
  const { XDG_DATA_HOME, XDG_STATE_HOME, XDG_CONFIG_HOME } = instance.env;
  const gh = XDG_CONFIG_HOME ? ghConfigDir({ platform, env: person }) : undefined;
  return {
    ...(XDG_DATA_HOME ? { XDG_DATA_HOME } : {}),
    ...(XDG_STATE_HOME ? { XDG_STATE_HOME } : {}),
    ...(XDG_CONFIG_HOME ? { XDG_CONFIG_HOME } : {}),
    ...(gh ? { GH_CONFIG_DIR: gh } : {}),
  };
}

/** Undefined masks the ambient variable when provider-kit merges process.env. */
export function instanceEnv(
  instance: ProviderInstance,
  base: NodeJS.ProcessEnv,
  backend?: "cursor-sdk" | "acp",
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const parsed = ProviderInstance.parse(instance);
  if (parsed.implicit) return { ...base };
  if (parsed.provider === "acp") return { ...base };
  const allowed =
    parsed.provider === "codex"
      ? ["CODEX_HOME"]
      : parsed.provider === "claude"
        ? ["CLAUDE_CONFIG_DIR"]
        : parsed.provider === "pi"
          ? ["PI_CODING_AGENT_DIR"]
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
  if (parsed.provider === "cursor" && backend === "cursor-sdk" && parsed.authMethod !== "api_key")
    env["CURSOR_API_KEY"] = base["CURSOR_API_KEY"];
  const selected = { ...env, ...appliedSelectors(parsed, base, platform) };
  return parsed.provider === "cursor" && backend === "cursor-sdk"
    ? cursorSdkEnvironment({ id: parsed.id, homeDir: parsed.homeDir }, selected)
    : selected;
}
export async function loginStatus(instance: ProviderInstance, options: DiscoveryOptions = {}) {
  if (instance.provider === "cursor")
    throw new Error("Cursor status requires the SDK account driver");
  if (instance.provider === "acp")
    return {
      installed: false,
      auth: "unknown" as const,
      loginHint: "Use the selected agent’s own CLI login",
      error: "ACP login status is unverified",
    };
  const result = await (
    instance.provider === "pi" ? discoverPiStatus : discoverProvider.bind(null, instance.provider)
  )({
    ...options,
    env: instanceEnv(instance, options.env ?? process.env),
  });
  return result;
}
export function loginArgs(
  provider: Provider,
  mode: "subscription" | "api" = "subscription",
): string[] {
  if (provider === "codex") {
    if (mode === "api")
      throw new Error("Use the provider.login.apiKey stdin hand-off for API-key sign-in");
    return ["login"];
  }
  if (provider === "pi") return [];
  if (provider === "claude") return ["auth", "login", mode === "api" ? "--console" : "--claudeai"];
  if (provider === "cursor") throw new Error("Sign in to Cursor through the SDK browser flow");
  return openCodeAuthArgs("login");
}

export function logoutArgs(provider: Provider): string[] {
  if (provider === "pi") return [];
  if (provider === "cursor") throw new Error("Sign out of Cursor through the SDK auth flow");
  if (provider === "opencode") return openCodeAuthArgs("logout");
  return provider === "codex" ? ["logout"] : ["auth", "logout"];
}

/**
 * Conventional homes only; no auth files, no recursion, capped inventory. `env` is the user's
 * environment, for OpenCode's XDG roots (absolute `XDG_*_HOME` values only, per the XDG spec).
 */
export async function discoverHomes(
  userHome: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ProviderInstance[]> {
  const results: ProviderInstance[] = [];
  const directory = await opendir(userHome);
  for await (const entry of directory) {
    if (results.length >= 256) break;
    if (!entry.isDirectory()) continue;
    const match = /^\.(codex|claude|opencode)(?:[-_][\w.-]+)?$/.exec(entry.name);
    if (!match) continue;
    const provider = match[1];
    if (provider !== "codex" && provider !== "claude" && provider !== "opencode") continue;
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
  const xdg = (name: string, fallback: string[]) => {
    const configured = env[name];
    return configured && isAbsolute(configured) ? configured : join(userHome, ...fallback);
  };
  const data = xdg("XDG_DATA_HOME", [".local", "share"]);
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
            XDG_CONFIG_HOME: xdg("XDG_CONFIG_HOME", [".config"]),
            XDG_STATE_HOME: xdg("XDG_STATE_HOME", [".local", "state"]),
            XDG_CACHE_HOME: xdg("XDG_CACHE_HOME", [".cache"]),
          },
        }),
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return results;
}
