import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ProviderLoginFailure } from "@ace/accounts";
import { GcpLocation, GcpProjectId } from "@ace/protocol";

/*
 * Antigravity's ACP server reads the Google Cloud project and location for Gemini Enterprise and
 * Agent Platform from `<home>/antigravity-acp/settings.json`. Before such a sign-in, ace writes
 * only those two non-secret values there, keeping every other key, and swaps the file in whole.
 * It never writes credentials, and never rewrites a file it can't read as plain JSON.
 */

const maxSettingsBytes = 1024 * 1024;
const unreadable =
  "Antigravity's settings.json isn't plain JSON, so ace won't rewrite it. Set gcp.project and gcp.location in it yourself, then sign in again.";
const unwritable =
  "ace couldn't save the project and location to Antigravity's settings.json. Check that folder's permissions, then try again.";

/** The Gemini home the person's own Antigravity uses: `GEMINI_HOME`, else `~/.gemini`. */
export function personalGeminiHome(env: NodeJS.ProcessEnv): string | undefined {
  const home = env["HOME"];
  const chosen = env["GEMINI_HOME"];
  if (chosen) {
    const expanded = chosen.startsWith("~/") && home ? join(home, chosen.slice(2)) : chosen;
    return isAbsolute(expanded) ? resolve(expanded) : undefined;
  }
  return home && isAbsolute(home) ? join(home, ".gemini") : undefined;
}

/** Where the agent reads its settings, inside an Antigravity home. */
export function antigravitySettingsFile(home: string): string {
  return join(home, "antigravity-acp", "settings.json");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Set `gcp.project` and `gcp.location` in a settings file. `followLinks` is for the person's own
 * home, where a linked file is theirs to keep; in a home ace made, a link is refused.
 */
export async function writeAntigravityGcp(
  file: string,
  gcp: { project: string; location: string },
  options: { followLinks: boolean },
): Promise<void> {
  const project = GcpProjectId.parse(gcp.project);
  const location = GcpLocation.parse(gcp.location);
  let target = file;
  let mode = 0o600;
  let raw: Record<string, unknown> = {};
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    if (options.followLinks) target = await realpath(file).catch(() => file);
    else if ((await lstat(file).catch(() => undefined))?.isSymbolicLink())
      throw new ProviderLoginFailure(unwritable);
    const existing = await stat(target).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.size > maxSettingsBytes)
        throw new ProviderLoginFailure(unreadable);
      mode = existing.mode & 0o777;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(target, "utf8"));
      } catch {
        throw new ProviderLoginFailure(unreadable);
      }
      if (!plainObject(parsed)) throw new ProviderLoginFailure(unreadable);
      raw = parsed;
    }
  } catch (error) {
    if (error instanceof ProviderLoginFailure) throw error;
    throw new ProviderLoginFailure(unwritable);
  }
  const before = plainObject(raw["gcp"]) ? raw["gcp"] : {};
  if (before["project"] === project && before["location"] === location) return;
  const updated = { ...raw, gcp: { ...before, project, location } };
  const temporary = join(dirname(target), `.settings-${randomBytes(6).toString("hex")}.json`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new ProviderLoginFailure(unwritable);
  }
}
