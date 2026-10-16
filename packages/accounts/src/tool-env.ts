import type { SessionContext } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";

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
  // Host selector, not a credential: gh needs it to aim a token at GHES.
  "GH_HOST",
  // Agent socket path, not key material: signing without copying private keys.
  "SSH_AUTH_SOCK",
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

/**
 * Merge vault-submitted entries into a session: an explicit user submission
 * wins over daemon-composed session values. Pure: no I/O.
 */
export function overlayToolEnv(
  context: Pick<SessionContext, "toolEnv">,
  submitted: NodeJS.ProcessEnv | undefined,
): SessionContext["toolEnv"] {
  if (!submitted) return context.toolEnv;
  return { ...context.toolEnv, ...submitted };
}

/**
 * Attach one thread's vault entries to its session, if any are live. The
 * engine calls this on every provider open; filtering still happens later in
 * `AccountService`, so denied values cannot reach a provider process.
 */
export function withSubmittedToolEnv<S extends Pick<SessionContext, "threadId" | "toolEnv">>(
  session: S,
  vault: {
    get(threadId: ThreadId, isLive: (threadId: ThreadId) => boolean): NodeJS.ProcessEnv | undefined;
  },
  isLive: (threadId: ThreadId) => boolean,
): S {
  const submitted = vault.get(session.threadId, isLive);
  if (submitted === undefined) return session;
  return { ...session, toolEnv: overlayToolEnv(session, submitted) };
}
