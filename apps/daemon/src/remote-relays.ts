import { join } from "node:path";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import type { KeyPair } from "@ace/secure-channel";
import { RelayRefusedError } from "@ace/relay";
import { startRelayTransport } from "./services/transports.ts";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { RelayPlan } from "./remote-policy.ts";
import { hostedRelayAccess, relayRefusedMachine, signInForRelay } from "./relay-account.ts";

type Handle = NonNullable<Awaited<ReturnType<typeof startRelayTransport>>>;

/** One relay registration and how it's going. */
interface Entry {
  plan: RelayPlan;
  handle?: Handle | undefined;
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

/**
 * The relays this machine registers on, each started, refused and stopped on its own: one
 * failing never stops another, or the direct listener. ace's relay gets a fresh machine grant
 * for every registration.
 */
export function remoteRelays(deps: {
  options: ServerOptions;
  auth: RemoteAuth;
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
      Object.assign(entry, { state: "waiting", error: signInForRelay, retryable: false });
      return;
    }
    try {
      const relayKeys = await hostKeys();
      const access = plan.hosted
        ? hostedRelayAccess(options.machineAccount, relayKeys, {
            name: await deps.machineName(),
            platform: options.platform ?? process.platform,
          })
        : undefined;
      const started = await startRelayTransport(
        options,
        deps.auth,
        { url: plan.url, keys: relayKeys },
        {
          ...(access ? { account: access.account } : {}),
          onRefused: () => {
            const error = plan.hosted ? relayRefusedMachine : "The relay refused this machine.";
            options.log?.(new Error(error));
            void deps
              .serialize(async () => {
                if (entries.get(plan.key) !== entry || entry.handle !== started) return;
                await stop(entry, true);
                Object.assign(entry, { state: "failed", error, retryable: false });
              })
              .catch(() => {});
          },
        },
      );
      if (!started) throw new Error("The relay didn't start");
      entry.handle = started;
      entry.state = "on";
      entry.error = undefined;
      entry.retryable = true;
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
      Object.assign(entry, {
        state: error === signInForRelay ? "waiting" : "failed",
        error,
        retryable: !(plan.hosted && (refused || error === signInForRelay)),
      });
      options.log?.(new Error(error));
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
     * Brings the registrations to `plans`: stops those no longer planned, keeps those running,
     * and starts the rest unless they wait on the person. `retryRefused` also tries those
     * again, as an account change does.
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
        if (entry?.state === "on") continue;
        if (entry && !entry.retryable && !retryRefused) continue;
        if (!entry) {
          entry = { plan, state: "failed", retryable: true };
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
    /** A relay that failed and a timer may try again. */
    retryable: () => [...entries.values()].some((entry) => entry.state !== "on" && entry.retryable),
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
