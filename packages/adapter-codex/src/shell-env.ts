/**
 * The agent's shell variables (ADR 0178 §10) as Codex config overrides for one thread. One
 * app-server serves many threads, so its process environment can't name the thread; Codex's
 * `shell_environment_policy.set` applies to every command the thread's shell tool runs. Each
 * variable is its own dotted key, so the person's own `set` entries are kept. Pure.
 */
export function codexShellEnvConfig(
  agentEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentEnv ?? {})
      .filter(([name]) => /^[A-Z][A-Z0-9_]*$/.test(name))
      .map(([name, value]) => [`shell_environment_policy.set.${name}`, value]),
  );
}
