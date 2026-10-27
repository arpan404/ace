import { subscribeLockedUse, type ClientApi, type RetryTimers } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import type { LockedUseResult, LockedUseStatus } from "@ace/protocol";
import { useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { lockedUseRefusal } from "./locked-use-reading.ts";

const timers: RetryTimers = {
  set(delay, run) {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
};

interface Reading {
  status: LockedUseStatus | undefined;
  /** The last read failed; it retries on its own while the connection stays up. */
  failed: boolean;
}

/**
 * This Mac's locked-use state, kept live while someone reads it: one `lockedUse.subscribe`,
 * renewed after every reconnect. A reply's status lands here too, ahead of its push.
 */
class LockedUseWatch {
  private reading: Reading = { status: undefined, failed: false };
  private listeners = new Set<() => void>();
  private subscription: { retry(): void; stop(): void } | undefined;
  private readonly client: ClientApi;
  constructor(client: ClientApi) {
    this.client = client;
  }
  get = (): Reading => this.reading;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.subscription ??= this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.subscription?.stop();
      this.subscription = undefined;
    };
  };
  receive(status: LockedUseStatus) {
    this.set({ status, failed: false });
  }
  /** Read again now: a fresh subscription, since the daemon refuses a repeated id. */
  recheck() {
    if (!this.subscription) return;
    this.subscription.stop();
    this.subscription = this.start();
  }
  private start() {
    return subscribeLockedUse(
      this.client,
      `web-locked-use-${crypto.randomUUID()}`,
      (status) => this.set({ status, failed: false }),
      () => this.set({ ...this.reading, failed: true }),
      timers,
    );
  }
  private set(reading: Reading) {
    this.reading = reading;
    for (const listener of this.listeners) listener();
  }
}

const watches = new WeakMap<ClientApi, LockedUseWatch>();
function watchFor(client: ClientApi): LockedUseWatch {
  let watch = watches.get(client);
  if (!watch) {
    watch = new LockedUseWatch(client);
    watches.set(client, watch);
  }
  return watch;
}

type Action = "install" | "remove" | "repair";
const failures: Record<Action, string> = {
  install: "Couldn't turn on locked use",
  remove: "Couldn't turn off locked use",
  repair: "Couldn't repair locked use",
};

/**
 * Locked computer use for the Settings row: the Mac's actual state, the stored intent
 * (`computer.lockedUse`), and install, remove and repair. Each change is one request; a refusal
 * becomes a toast. Nothing is retried on its own.
 */
export function useLockedUse() {
  const client = useClient();
  const connected = useConnectionState() === "ready";
  const toast = useToast();
  const watch = watchFor(client);
  const reading = useSyncExternalStore(watch.subscribe, watch.get, watch.get);
  const [intent, setIntent] = useDaemonSetting("computer.lockedUse");
  const [pending, setPending] = useState(0);

  const send = (action: Action): Promise<LockedUseResult> => {
    if (action === "install") return client.request({ type: "lockedUse.install" });
    if (action === "remove") return client.request({ type: "lockedUse.remove" });
    return client.request({ type: "lockedUse.repair" });
  };

  const run = async (action: Action, storeIntent?: boolean) => {
    setPending((count) => count + 1);
    try {
      if (storeIntent !== undefined) await setIntent(storeIntent);
      const result = await send(action);
      if (result.status) watch.receive(result.status);
      if (!result.ok)
        toast.error({
          title: failures[action],
          description: lockedUseRefusal(result.code, result.reason),
        });
    } catch (error) {
      toast.error({
        title: failures[action],
        description:
          error instanceof Error ? error.message : lockedUseRefusal(undefined, undefined),
      });
    } finally {
      setPending((count) => count - 1);
    }
  };

  return {
    status: reading.status,
    failed: reading.failed,
    connected,
    intent,
    pending: pending > 0,
    /** Turn it on: store the intent, then install (macOS asks for an administrator). */
    install: () => run("install", true),
    /** Turn it off: store the intent, then remove the component. */
    remove: () => run("remove", false),
    repair: () => run("repair"),
    /** Read the Mac's state again now. */
    recheck: () => watch.recheck(),
  };
}

export type LockedUse = ReturnType<typeof useLockedUse>;
