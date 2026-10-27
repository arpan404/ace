import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

/**
 * Gemini CLI's folder trust, as 0.43.0 resolves it (`checkPathTrust` and `LoadedTrustedFolders` in
 * its core bundle). In a folder it does not trust, Gemini starts no MCP server at all, so ace's
 * tools are absent, and it refuses its privileged approval modes, so full access fails to start.
 *
 * - `GEMINI_CLI_TRUST_WORKSPACE=true` trusts the process's folders.
 * - With `security.folderTrust.enabled` false (its schema default is true) every folder is trusted.
 * - Otherwise the longest matching rule in `trustedFolders.json` decides: `TRUST_FOLDER` covers the
 *   folder and everything under it, `TRUST_PARENT` the rule's parent, `DO_NOT_TRUST` refuses.
 *   Paths are compared as real paths, case-insensitively on macOS and Windows. No rule: untrusted.
 */
export const geminiTrustEnv = "GEMINI_CLI_TRUST_WORKSPACE";

const TrustLevel = z.enum(["TRUST_FOLDER", "TRUST_PARENT", "DO_NOT_TRUST"]);
export type GeminiTrustLevel = z.infer<typeof TrustLevel>;
export interface GeminiTrustRule {
  /** The rule's key as Gemini normalizes it; its length ranks overlapping rules. */
  readonly path: string;
  readonly level: GeminiTrustLevel;
  /** The real folder the rule covers: its own path, or its parent for `TRUST_PARENT`. */
  readonly covers: string;
}
export interface GeminiTrustFacts {
  readonly envTrusted: boolean;
  readonly folderTrustEnabled: boolean;
  readonly rules: readonly GeminiTrustRule[];
  readonly caseInsensitive: boolean;
  /** The session's folder, as a real path. */
  readonly cwd: string;
  /** For a worktree ace created, the real path of the checkout it was created from. */
  readonly source?: string | undefined;
}
export type GeminiWorkspaceTrust =
  | { readonly state: "trusted" }
  /** An ace worktree with no rule of its own, made from a checkout the person trusts. */
  | { readonly state: "inherited"; readonly from: string }
  | { readonly state: "untrusted"; readonly denied: boolean };

function within(folder: string, location: string, caseInsensitive: boolean): boolean {
  const fold = (path: string) => (caseInsensitive ? path.toLowerCase() : path);
  const path = relative(fold(folder), fold(location));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Gemini's verdict for one folder from its rules alone: undefined when no rule covers it. */
function ruled(facts: GeminiTrustFacts, location: string): boolean | undefined {
  let best: GeminiTrustRule | undefined;
  for (const rule of facts.rules)
    if (within(rule.covers, location, facts.caseInsensitive))
      if (!best || rule.path.length > best.path.length) best = rule;
  return best ? best.level !== "DO_NOT_TRUST" : undefined;
}

/**
 * Whether Gemini will trust a session's folder, and whether ace should extend the trust the person
 * gave a checkout to a worktree ace made from it. A folder with its own rule keeps it: ace never
 * overrides a `DO_NOT_TRUST`, and never trusts a folder the person has not trusted through its
 * source.
 */
export function geminiWorkspaceTrust(facts: GeminiTrustFacts): GeminiWorkspaceTrust {
  if (facts.envTrusted || !facts.folderTrustEnabled) return { state: "trusted" };
  const own = ruled(facts, facts.cwd);
  if (own !== undefined) return own ? { state: "trusted" } : { state: "untrusted", denied: true };
  if (facts.source !== undefined && ruled(facts, facts.source) === true)
    return { state: "inherited", from: facts.source };
  return { state: "untrusted", denied: false };
}

const Settings = z.looseObject({
  security: z
    .looseObject({ folderTrust: z.looseObject({ enabled: z.boolean().optional() }).optional() })
    .optional(),
});
const Rules = z.record(z.string(), TrustLevel);

async function jsonc(path: string): Promise<unknown> {
  try {
    const errors: ParseError[] = [];
    const result: unknown = parse(await readFile(path, "utf8"), errors);
    if (errors.length) throw new Error(`Invalid Gemini configuration: ${path}`);
    return result;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
function systemSettingsPath(env: Readonly<Record<string, string | undefined>>, platform: string) {
  const override = env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"];
  if (override) return override;
  if (platform === "darwin") return "/Library/Application Support/GeminiCli/settings.json";
  if (platform === "win32") return "C:\\ProgramData\\gemini-cli\\settings.json";
  return "/etc/gemini-cli/settings.json";
}
async function folderTrustSetting(path: string): Promise<boolean | undefined> {
  const settings = Settings.safeParse(await jsonc(path).catch(() => undefined));
  return settings.success ? settings.data.security?.folderTrust?.enabled : undefined;
}

/**
 * Reads what Gemini reads for trust, from the environment it will launch with: the env override,
 * the user and system settings (system wins), and the trusted-folders file. A missing trust file means no rules; an unreadable or invalid trust file fails before ace can
 * extend trust, matching Gemini's refusal to start with invalid trust configuration.
 */
export async function readGeminiTrustFacts(input: {
  env: Readonly<Record<string, string | undefined>>;
  userHome: string;
  platform: string;
  cwd: string;
  source?: string | undefined;
}): Promise<GeminiTrustFacts> {
  const { env, platform } = input;
  const home = resolve(
    input.cwd,
    env["GEMINI_CLI_HOME"] ||
      (platform === "win32" ? env["USERPROFILE"] : env["HOME"]) ||
      input.userHome,
  );
  const geminiDir = join(home, ".gemini");
  const caseInsensitive = platform === "darwin" || platform === "win32";
  const systemPath = resolve(input.cwd, systemSettingsPath(env, platform));
  const [defaults, user, system] = await Promise.all([
    folderTrustSetting(
      resolve(
        input.cwd,
        env["GEMINI_CLI_SYSTEM_DEFAULTS_PATH"] || join(dirname(systemPath), "system-defaults.json"),
      ),
    ),
    folderTrustSetting(join(geminiDir, "settings.json")),
    folderTrustSetting(systemPath),
  ]);
  const folderTrustEnabled = system ?? user ?? defaults ?? true;
  const file =
    env[geminiTrustEnv] === "true" || !folderTrustEnabled
      ? undefined
      : await jsonc(
          resolve(
            input.cwd,
            env["GEMINI_CLI_TRUSTED_FOLDERS_PATH"] || join(geminiDir, "trustedFolders.json"),
          ),
        );
  const entries = Rules.safeParse(file);
  if (file !== undefined && !entries.success)
    throw new Error(
      "Invalid Gemini trusted folders configuration; fix trustedFolders.json in the selected Gemini home.",
    );
  // Gemini normalizes keys while loading its record. A later spelling of the same path
  // replaces the earlier verdict before longest-match selection or realpath resolution.
  const normalized = new Map<string, GeminiTrustLevel>();
  for (const [raw, level] of Object.entries(entries.success ? entries.data : {})) {
    const absolute = resolve(input.cwd, raw).replaceAll("\\", "/");
    normalized.set(caseInsensitive ? absolute.toLowerCase() : absolute, level);
  }
  const rules = await Promise.all(
    [...normalized].map(async ([path, level]) => ({
      path,
      level,
      covers: await real(level === "TRUST_PARENT" ? dirname(path) : path),
    })),
  );
  return {
    envTrusted: env[geminiTrustEnv] === "true",
    folderTrustEnabled,
    rules,
    caseInsensitive,
    cwd: await real(input.cwd),
    ...(input.source !== undefined ? { source: await real(input.source) } : {}),
  };
}
