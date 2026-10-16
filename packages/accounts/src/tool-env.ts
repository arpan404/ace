/**
 * Per-session tool-credential forwarding for isolated (managed) account homes.
 *
 * A managed home rewrites HOME/XDG roots, so tools inside it cannot see the
 * user's own `~/.config/gh`, `~/.ssh` or `~/.gitconfig`. Copying those into the
 * isolated home would leak one account's credentials into another. Instead a
 * session may carry explicit, memory-only tool credentials that reach exactly
 * one provider process launch and are never persisted.
 *
 * Only the keys listed here survive {@link filterSessionToolEnv}. Everything
 * else (PATH, LD_PRELOAD, HOME overrides, provider auth) is dropped, and home
 * selectors applied later by `instanceEnv` still win, so a session can never
 * redirect another account's home.
 */
export const forwardedToolEnvKeys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "SSH_AUTH_SOCK",
  "NPM_TOKEN",
] as const;

/** Maximum accepted value length; tokens and socket paths are far smaller. */
export const maxForwardedToolEnvLength = 8192;

const allowed = new Set<string>(forwardedToolEnvKeys);

/** Keep only allowlisted string values with bounded length. Pure: no I/O. */
export function filterSessionToolEnv(input: unknown): NodeJS.ProcessEnv {
  if (!input || typeof input !== "object") return {};
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== "string") continue;
    if (value.length === 0 || value.length > maxForwardedToolEnvLength) continue;
    out[key] = value;
  }
  return out;
}
