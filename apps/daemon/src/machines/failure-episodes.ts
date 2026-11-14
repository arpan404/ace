/**
 * Runs of failures, so a loop that repeats a call logs a failure when it starts (or changes to a
 * new outcome) and its end with the count of attempts, never a line per attempt.
 */
export class FailureEpisodes {
  private open = new Map<string, { attempts: number; outcome: string }>();
  /** Counts a failure; `log` is true when it starts an episode or its outcome changed. */
  failed(key: string, outcome: string): { log: boolean; attempts: number } {
    const episode = this.open.get(key);
    const attempts = (episode?.attempts ?? 0) + 1;
    this.open.set(key, { attempts, outcome });
    return { log: episode?.outcome !== outcome, attempts };
  }
  /** Whether the key is in a failure episode. */
  failing(key: string): boolean {
    return this.open.has(key);
  }
  /** Drops every episode whose key starts with `prefix`, as for a pairing that is gone. */
  forgetPrefix(prefix: string): void {
    for (const key of this.open.keys()) if (key.startsWith(prefix)) this.open.delete(key);
  }
  /** Ends the key's episode; the failed attempts it had, 0 when none was open. */
  succeeded(key: string): number {
    const attempts = this.open.get(key)?.attempts ?? 0;
    this.open.delete(key);
    return attempts;
  }
}

/**
 * Calls a remote parent or this daemon's poll repeats about once a second, which read and change
 * nothing: a success is not logged per call, only a failure episode's start and end.
 */
export const routineOps = ["status", "describe", "command.jobs"] as const;
export function routineCall(op: string): boolean {
  return (routineOps as readonly string[]).includes(op);
}
