import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { waitingNote } from "@/lib/daemon-command.ts";

/*
 * A choice the person made on a thread (approval mode, model) that is shown at once, before the
 * daemon reports it (UX audit SY-11). The command behind it is durable: offline or slow it
 * waits, and only a definite refusal takes the choice back. Once the daemon has the command, the
 * choice gives way as soon as the thread's state moves, so the daemon's word wins from then on.
 */

interface Entry<T> {
  value: T;
  /** The thread's state when the choice was made. */
  base: string;
  /** The daemon has the command. */
  acked: boolean;
}

/** The choices of one kind on one client, by thread. */
class Choices<T> {
  private entries = new Map<string, Entry<T>>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  get(key: string): Entry<T> | undefined {
    return this.entries.get(key);
  }
  /** Replace `from` (when it is still the latest choice) with `to`, or drop it. */
  swap(key: string, from: Entry<T> | undefined, to: Entry<T> | undefined): void {
    if (this.entries.get(key) !== from) return;
    if (to) this.entries.set(key, to);
    else this.entries.delete(key);
    for (const listener of this.listeners) listener();
  }
}

/**
 * One kind of choice. Kept per client, so a window's views share it (the + menu's Plan first and
 * the approvals chip) and a new client (a test, another daemon) starts clean.
 */
export function choiceKind<T>(): (client: ClientApi) => Choices<T> {
  const byClient = new WeakMap<ClientApi, Choices<T>>();
  return (client) => {
    let choices = byClient.get(client);
    if (!choices) byClient.set(client, (choices = new Choices<T>()));
    return choices;
  };
}

/** After this long without the daemon's receipt, say it's slow. */
const slowAfterMs = 5_000;

function useSlow(waiting: object | undefined): boolean {
  const [slowFor, setSlowFor] = useState<object>();
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlowFor(waiting), slowAfterMs);
    return () => clearTimeout(timer);
  }, [waiting]);
  return waiting !== undefined && slowFor === waiting;
}

export interface PendingChoice<T> {
  /** The choice to show instead of what the daemon reports; undefined when there is none. */
  chosen: { value: T } | undefined;
  /** While the daemon hasn't got it: "Will apply when reconnected", "Still waiting…". */
  note: string | undefined;
  /** Show `value` now and run the command; rejects (and takes it back) when that fails. */
  choose(value: T, run: () => Promise<unknown>): Promise<void>;
}

/** The choice of `kind` on thread `key`, against `current`, the thread's state as a string. */
export function usePendingChoice<T>(
  kind: (client: ClientApi) => Choices<T>,
  key: string,
  current: string,
): PendingChoice<T> {
  const choices = kind(useClient());
  const entry = useSyncExternalStore(choices.subscribe, () => choices.get(key));
  const online = useConnectionState() === "ready";
  const waiting = entry && !entry.acked ? entry : undefined;
  const slow = useSlow(waiting);
  const shown = entry && (!entry.acked || entry.base === current) ? entry : undefined;
  const choose = useCallback(
    async (value: T, run: () => Promise<unknown>) => {
      const mine: Entry<T> = { value, base: current, acked: false };
      choices.swap(key, choices.get(key), mine);
      try {
        await run();
      } catch (error) {
        choices.swap(key, mine, undefined);
        throw error;
      }
      choices.swap(key, mine, { ...mine, acked: true });
    },
    [choices, key, current],
  );
  return {
    chosen: shown && { value: shown.value },
    note: waiting ? waitingNote({ online, slow }) : undefined,
    choose,
  };
}
