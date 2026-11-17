/**
 * Each OpenCode session's own shell variables (ADR 0176 §10).
 *
 * An OpenCode server serves many sessions, and ace starts it before any thread exists, so its
 * process environment can't name a thread. OpenCode's `PUT /api/session/:id/environment` sets
 * the environment its local shell commands run with for one session (checked against
 * `@opencode/client` 2.0.22 and OpenCode 2.3.0): it replaces the server's process environment
 * for that session only, lives in the server's memory until the session is removed or the
 * server exits, and is not inherited by subagent sessions. So ace sends the whole environment
 * the server's own shells would have had, plus the thread's variables, for the root session
 * at every open and for every subagent session as ace admits it into the tree.
 */

/** OpenCode's own server credentials: the server needs them, an agent's shell never does. */
const serverOnly = new Set(["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]);

/**
 * What one session's shell commands run with: what the server process inherited, without its
 * own credentials, then the thread's variables, which win over a same-named inherited one.
 * Pure.
 */
export function sessionShellEnvironment(
  inherited: NodeJS.ProcessEnv,
  agentEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited))
    if (value !== undefined && !serverOnly.has(name)) variables[name] = value;
  return { ...variables, ...agentEnv };
}
