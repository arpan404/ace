import type { ProviderKind } from "@ace/protocol";

export interface ProviderFactsPorts {
  /** Discovers a provider with no adapter yet, as a command for it would. */
  ensureProvider(provider: ProviderKind): Promise<void>;
  /** Reads one ACP account's own login and records it; stops when `signal` aborts. */
  acpLogin?(instanceId: string, signal: AbortSignal): Promise<void>;
  now(): number;
  schedule(run: () => void, milliseconds: number): () => void;
}

/**
 * What delegation admission reads about the requested provider and account, made current
 * first. Delegations start with nobody watching (automations, other machines' calls), so nothing
 * else may have looked since a CLI was installed or an ACP agent's login changed outside ace.
 *
 * Only those facts are read: a provider with no adapter is discovered, and an ACP account
 * whose login was last read five minutes ago or more reads it again (concurrent delegations
 * share one read). Native CLIs' logins come from their accounts' own readings, and a too-old
 * version is re-checked by provider status on its own. The wait is bounded: after
 * `deadlineMs` admission goes ahead with the facts in hand, and the login read is stopped.
 */
export function providerFacts(
  ports: ProviderFactsPorts,
  limits: { deadlineMs?: number; maxAgeMs?: number } = {},
): (provider: ProviderKind, account?: string) => Promise<void> {
  const deadlineMs = limits.deadlineMs ?? 3_000;
  const maxAgeMs = limits.maxAgeMs ?? 300_000;
  const readAt = new Map<string, number>();
  const reading = new Map<string, Promise<void>>();
  const login = (account: string, acpLogin: NonNullable<ProviderFactsPorts["acpLogin"]>) => {
    const pending = reading.get(account);
    if (pending) return pending;
    const controller = new AbortController();
    const stop = ports.schedule(() => controller.abort(), deadlineMs);
    const read = acpLogin(account, controller.signal)
      .then(
        () => {
          if (!controller.signal.aborted) readAt.set(account, ports.now());
        },
        () => {},
      )
      .finally(() => {
        stop();
        reading.delete(account);
      });
    reading.set(account, read);
    return read;
  };
  return async (provider, account) => {
    const work: Promise<unknown>[] = [ports.ensureProvider(provider).catch(() => {})];
    const last = account === undefined ? undefined : readAt.get(account);
    if (
      provider === "acp" &&
      account !== undefined &&
      ports.acpLogin &&
      (last === undefined || ports.now() - last >= maxAgeMs)
    )
      work.push(login(account, ports.acpLogin));
    let cancel: (() => void) | undefined;
    const deadline = new Promise<void>((resolve) => {
      cancel = ports.schedule(resolve, deadlineMs);
    });
    try {
      await Promise.race([Promise.all(work), deadline]);
    } finally {
      cancel?.();
    }
  };
}
