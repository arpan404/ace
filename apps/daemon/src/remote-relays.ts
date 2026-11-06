import { join } from "node:path";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import type { KeyPair } from "@ace/secure-channel";
import { RelayRefusedError } from "@ace/relay";
import type { ServerOptions } from "./server-options.ts";
import type { RelayPlan } from "./remote-policy.ts";
import { hostedRelayAccess, relayRefusedMachine, signInForRelay } from "./relay-account.ts";

/** What a relay connection needs beyond its address and keys (see `startRelayTransport`). */
export interface RelayAccess {
  account?: { grant(signal: AbortSignal): Promise<string>; name?: string; platform?: string };
  onRefused?: (error: RelayRefusedError) => void;
  onRegistration?: (registered: boolean) => void;
}

/** A running relay registration: resolved once the relay confirmed it, until `close`. */
export interface RelayHandle {
  relayHostId: string;
  close(): Promise<void>;
}

/** One relay registration and how it's going. */
interface Entry {
  plan: RelayPlan;
  handle?: RelayHandle | undefined;
  state: "on" | "waiting" | "failed";
  error?: string | undefined;
  /** A timer may try it again. False while it waits on the person: a sign-in, or a refusal. */
  retryable: boolean;
}

export interface RelayView {
  plan: RelayPlan;
  state: Entry["state"];
  error?: string;
}

/** The registration was confirmed and then lost; the connection is registering again. */
export function relayReconnecting(plan: RelayPlan): string {
  const name = plan.hosted ? "ace's relay" : `the relay at ${new URL(plan.url).host}`;
  return `Lost the connection to ${name}. Reconnecting.`;
}

/**
 * The relays this machine registers on, each started, refused and stopped on its own: one
 * failing never stops another, or the direct listener. ace's relay gets a fresh machine grant
 * for every registration. A relay is `on` only while the relay confirms its registration (for
 * ace's relay, once the account lists this machine); a lost registration shows as waiting while
 * the connection registers again by itself.
 */
export function remoteRelays(deps: {
  options: Pick<ServerOptions, "remoteConfig" | "machineAccount" | "platform" | "log" | "relay">;
  /** Opens a relay registration, resolving once the relay confirmed it. */
  connect: (
    relay: { url: string; keys: KeyPair },
    access: RelayAccess,
  ) => Promise<RelayHandle | undefined>;
  /** How this machine is labelled in the account's machine list. */
  machineName: () => Promise<string | undefined>;
  /** Runs `work` in the runtime's serialized queue. */
  serialize: (work: () => Promise<void>) => Promise<void>;
  /** A pairing link through the person's own relay stops working. */
  clearPending: () => void;
}) {
  const { options } = deps;
  const entries = new Map<string, Entry>();
  let keys: KeyPair | undefined;
  const hostKeys = async () => {
    const config = options.remoteConfig;
    if (!config) throw new Error("Remote access is unavailable");
    keys ??= await loadOrCreateHostKeys(join(config.dataDir, "relay"));
    return keys;
  };
  /** Shows `state` and `error`, logging an error once when it first appears, not per retry. */
  const show = (entry: Entry, next: Pick<Entry, "state" | "error" | "retryable">) => {
    if (next.error && next.error !== entry.error) options.log?.(new Error(next.error));
    Object.assign(entry, next);
  };
  const stop = async (entry: Entry, withdrawLinks: boolean) => {
    const handle = entry.handle;
    entry.handle = undefined;
    if (!handle) return;
    if (withdrawLinks && !entry.plan.hosted) deps.clearPending();
    await handle.close();
  };
  const start = async (entry: Entry) => {
    const { plan } = entry;
    if (plan.hosted && plan.accountId === undefined) {
      // Waiting on the person, not a failure: shown, never logged.
      Object.assign(entry, { state: "waiting", error: signInForRelay, retryable: false });
      return;
    }
    let started: RelayHandle | undefined;
    // Events from this registration only, while it is the one running for this entry.
    const current = () => entries.get(plan.key) === entry && started && entry.handle === started;
    try {
      const relayKeys = await hostKeys();
      const access = plan.hosted
        ? hostedRelayAccess(options.machineAccount, relayKeys, {
            name: await deps.machineName(),
            platform: options.platform ?? process.platform,
          })
        : undefined;
      started = await deps.connect(
        { url: plan.url, keys: relayKeys },
        {
          ...(access ? { account: access.account } : {}),
          onRefused: () => {
            const error = plan.hosted ? relayRefusedMachine : "The relay refused this machine.";
            void deps
              .serialize(async () => {
                if (!current()) return;
                await stop(entry, true);
                show(entry, { state: "failed", error, retryable: false });
              })
              .catch(() => {});
          },
          onRegistration: (registered) => {
            if (!current()) return;
            if (registered) show(entry, { state: "on", error: undefined, retryable: true });
            else show(entry, { state: "waiting", error: relayReconnecting(plan), retryable: true });
          },
        },
      );
      if (!started) throw new Error("The relay didn't start");
      entry.handle = started;
      show(entry, { state: "on", error: undefined, retryable: true });
    } catch (failure) {
      const refused = failure instanceof RelayRefusedError;
      // ace's relay refuses a machine whose account it can't confirm: that waits for a sign-in.
      // A self-hosted relay's own refusal (an allowlist) is tried again.
      const error = refused
        ? plan.hosted
          ? relayRefusedMachine
          : "The relay refused this machine."
        : failure instanceof Error && failure.message === signInForRelay
          ? signInForRelay
          : `Couldn't reach the relay at ${new URL(plan.url).host}.`;
      show(entry, {
        state: error === signInForRelay ? "waiting" : "failed",
        error,
        retryable: !(plan.hosted && (refused || error === signInForRelay)),
      });
    }
  };
  /** Which relay `options.relay` names: the person's own while it runs, else ace's. */
  const publish = () => {
    const running = [...entries.values()].filter((entry) => entry.handle);
    const named = running.find((entry) => entry.plan.chosen) ?? running[0];
    options.relay = named && keys ? { url: named.plan.url, keys } : undefined;
  };
  return {
    /**
     * Brings the registrations to `plans`: stops those no longer planned, keeps those running
     * (a running connection registers again by itself), and starts the rest unless they wait on
     * the person. `retryRefused` also tries those again, as an account change does.
     */
    async apply(plans: readonly RelayPlan[], retryRefused = false): Promise<void> {
      const wanted = new Set(plans.map((plan) => plan.key));
      for (const [key, entry] of entries)
        if (!wanted.has(key)) {
          entries.delete(key);
          await stop(entry, true);
        }
      publish();
      for (const plan of plans) {
        let entry = entries.get(plan.key);
        if (entry?.handle) continue;
        if (entry && !entry.retryable && !retryRefused) continue;
        if (!entry) {
          entry = { plan, state: "waiting", retryable: true };
          entries.set(plan.key, entry);
        }
        await start(entry);
        publish();
      }
    },
    view(): RelayView[] {
      return [...entries.values()].map((entry) =>
        entry.error
          ? { plan: entry.plan, state: entry.state, error: entry.error }
          : { plan: entry.plan, state: entry.state },
      );
    },
    /** A relay that failed to start and a timer may try again. */
    retryable: () => [...entries.values()].some((entry) => !entry.handle && entry.retryable),
    /** Whether `key` failed to start. */
    failed: (key: string) => entries.get(key)?.state === "failed",
    relayHostId(): string | undefined {
      const running = [...entries.values()].filter((entry) => entry.handle);
      return (running.find((entry) => entry.plan.chosen) ?? running[0])?.handle?.relayHostId;
    },
    /** Whether the person's own relay (not ace's) is running, for pairing links. */
    selfHosted(): boolean {
      return [...entries.values()].some((entry) => entry.handle && !entry.plan.hosted);
    },
    async close(withdrawLinks: boolean): Promise<void> {
      for (const entry of entries.values()) await stop(entry, withdrawLinks);
      entries.clear();
      publish();
    },
  };
}
