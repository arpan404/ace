/**
 * Claude work that runs inside the CLI process: its subagents, and the placeholders that stand
 * for children awaiting registration. None of it can still be running once that process is
 * gone. Background shells are left out: they may outlive the CLI.
 */
export function claudeSessionBoundTask(key: string, kind: string): boolean {
  return key.startsWith("claude:") && (key.includes(":unbound:") || kind === "subagent");
}
