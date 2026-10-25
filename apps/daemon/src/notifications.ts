import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import {
  NotificationWorker,
  attachNotifications,
  createNotificationRouter,
  deliverableFor,
  type NotificationChannels,
  type NotificationState,
} from "@ace/notify";
import type { DeviceId, Notification } from "@ace/protocol";
import { allows } from "./devices.ts";
import { failureDelay, maySleep, wakeDelay } from "./notification-wake.ts";
import type { Store } from "./store.ts";
import { acceptIntents, dropIntents, isNotice } from "./notification-intents.ts";

const offline = () => false;
const nobody = (): readonly DeviceId[] => [];

/** The worker's calls. The daemon starts the worker on the first one that needs it. */
export type NotificationAccess = Pick<
  NotificationWorker,
  | "cursor"
  | "ingest"
  | "connectDevice"
  | "register"
  | "unregister"
  | "getPreferences"
  | "preferences"
  | "notify"
  | "snooze"
  | "updatePresence"
  | "feed"
  | "disconnect"
  | "revoke"
  | "drain"
  | "close"
>;
export interface DaemonNotifications {
  service: NotificationAccess;
  setSender(sender: (device: DeviceId, notification: Notification) => boolean): void;
  /** Devices with a live socket; while any is connected the worker stays up. */
  setConnected(connected: () => readonly DeviceId[]): void;
  /** Whether saved notification state needs the worker from startup (see `notificationsRetained`). */
  open(): Promise<void>;
  ready(): Promise<void>;
  tick(): Promise<void>;
  activate(): void;
  start(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
interface Runtime {
  signal?: AbortSignal;
  spawn?: ConstructorParameters<typeof NotificationWorker>[0]["spawn"];
  now?: () => number;
  delay?: (run: () => void, milliseconds: number) => () => void;
  /** How long an idle worker stays up before it stops. */
  quietMs?: number;
  /**
   * Nothing needed the worker when the daemon started (see `notificationsRetained`), so the
   * daemon runs without one from the log's current head: events after it count as slept
   * through. Events before it (a crash, say) are delivered normally.
   */
  slept?: boolean;
}
interface Awake {
  worker: NotificationWorker;
  attached: ReturnType<typeof attachNotifications>;
  alertsFrom: number;
  /** The first worker's first reply, for startup. Recovery asks whichever worker is current. */
  opened: Promise<void>;
  ready?: Promise<void>;
}
const unrefDelay = (run: () => void, milliseconds: number) => {
  const timer = setTimeout(run, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Notification delivery in a worker that runs only while something can receive an alert. It
 * starts on the first call that needs it, runs delivery when the worker's next deadline comes
 * (one timer, no polling) and stops after a quiet minute with nothing queued and nobody
 * connected. The worker's durable cursor replays what happened while it was stopped.
 */
export function createDaemonNotifications(
  dataDir: string,
  store: Store,
  onError: (error: unknown) => void,
  channels: Omit<NotificationChannels, "websocket"> = {},
  windowMs = 5000,
  runtime: Runtime = {},
): DaemonNotifications {
  const deliveryLifetime = new AbortController();
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, deliveryLifetime.signal])
    : deliveryLifetime.signal;
  const now = runtime.now ?? Date.now;
  const delay = runtime.delay ?? unrefDelay;
  const quietMs = runtime.quietMs ?? 60_000;
  let send: (device: DeviceId, notification: Notification) => boolean = offline;
  let connected = nobody;
  const delivery = createNotificationRouter({
    ...channels,
    websocket: (device, notification) => send(device, notification),
  });
  const report = (error: unknown) => {
    if (signal.aborted && error instanceof Error && error.name === "AbortError") return;
    onError(error);
  };
  let current: Awake | undefined;
  let sleeping: Promise<void> | undefined;
  let started = false;
  /** When the current deliberate stop began, while there is no worker. */
  let sleptAt: number | undefined = runtime.slept ? now() : undefined;
  const bootHead = store.headSeq();
  let active = false;
  let closed = false;
  let state: NotificationState | undefined;
  let calls = 0;
  const startups = new Set<Promise<void>>();
  const cancelled = () => {
    signal.throwIfAborted();
    if (closed) throw new DOMException("Notification startup aborted", "AbortError");
  };
  const track = (operation: Promise<void>) => {
    startups.add(operation);
    void operation.then(
      () => startups.delete(operation),
      () => startups.delete(operation),
    );
    return operation;
  };

  const begin = (): Awake => {
    cancelled();
    // While the worker slept no device could take an alert, so events in that window raise
    // none unless they are young enough that a running worker would still be retrying them.
    // The worker applies this only after a recorded sleep boundary.
    const alertsFrom = now() - deliverableFor(windowMs);
    const sleptAfter =
      !started && runtime.slept && sleptAt !== undefined
        ? { seq: bootHead, at: sleptAt }
        : undefined;
    started = true;
    sleptAt = undefined;
    state = undefined;
    const worker = new NotificationWorker({
      path: join(dataDir, "notifications.sqlite"),
      windowMs,
      alertsFrom: Math.max(0, alertsFrom),
      ...(sleptAfter ? { sleptAfter } : {}),
      onRestart: () => kick(),
      signal,
      ...(runtime.spawn ? { spawn: runtime.spawn } : {}),
      onState(next) {
        if (current?.worker !== worker) return;
        state = next;
        arm(next.deadline);
        if (next.idle) armSleep();
        else disarmSleep();
      },
      transport: {
        async send(device, notification, deliverySignal) {
          const paired = store.devices.get(device.id);
          if (paired?.revokedAt !== undefined && paired.revokedAt !== null) return "revoked";
          if (paired && !allows(paired, "read")) return "failed";
          return delivery.send(device, notification, deliverySignal);
        },
      },
    });
    const attached = attachNotifications(
      {
        cursor: () => worker.cursor(signal),
        // Admitted ingestion remains durable shutdown work, not cancellable startup.
        ingest: (events, coverage) => worker.ingest(events, coverage),
        drain: async () => {
          await acceptIntents(store, worker, []);
          await worker.drain();
        },
      },
      store,
      report,
      () => kick(),
    );
    const awake: Awake = {
      worker,
      attached,
      alertsFrom,
      opened: track(
        (async () => {
          await worker.cursor(signal);
          cancelled();
        })(),
      ),
    };
    return awake;
  };
  // Check after every RPC before scheduling another one, especially durable revocations.
  const catchUp = async (awake: Awake) => {
    // A worker replaced after a crash has its own first reply: ask the current one.
    await awake.worker.cursor(signal);
    cancelled();
    for (const device of store.devices.list()) {
      if (device.revokedAt === null) continue;
      cancelled();
      await awake.worker.revoke(device.id, signal);
      cancelled();
    }
    for (;;) {
      const recovered = await awake.attached.recover();
      cancelled();
      if (recovered) {
        await settleSleep(awake.worker);
        return;
      }
      await setImmediate();
      cancelled();
    }
  };
  /**
   * Closes the sleep window the replay caught up through, lets go of the agent notices queued
   * inside it, and only then forgets it. A crash before that leaves the window recorded, so a
   * restart still lets those notices go rather than delivering them late.
   */
  const settleSleep = async (worker: NotificationWorker) => {
    const windows = await worker.closeSleep();
    cancelled();
    if (!windows.length) return;
    while (await acceptIntents(store, worker, windows)) cancelled();
    cancelled();
    await worker.forgetSleep();
    cancelled();
  };
  const awaken = async (): Promise<Awake> => {
    for (;;) {
      cancelled();
      if (!sleeping) break;
      await sleeping;
    }
    const awake = (current ??= begin());
    const fresh = awake.ready === undefined;
    const ready = (awake.ready ??= track(catchUp(awake)));
    try {
      await ready;
    } catch (error) {
      // The worker restarts itself after a crash; the next call catches up again.
      if (awake.ready === ready) delete awake.ready;
      throw error;
    }
    if (fresh && active) kick();
    return awake;
  };
  // One delivery timer, armed at the earliest deadline the worker reported.
  let cancelTimer: (() => void) | undefined;
  let timerAt = Number.POSITIVE_INFINITY;
  let lastRunStartedAt: number | undefined;
  const arm = (deadline: number | null, at = now()) => {
    if (!active || closed) return;
    const wait = wakeDelay(deadline, at, lastRunStartedAt);
    if (wait === undefined || at + wait >= timerAt) return;
    cancelTimer?.();
    timerAt = at + wait;
    cancelTimer = delay(() => {
      cancelTimer = undefined;
      timerAt = Number.POSITIVE_INFINITY;
      void run();
    }, wait);
  };
  let running: Promise<void> | undefined;
  let again = false;
  let failures = 0;
  const run = (): Promise<void> => {
    if (closed || !current) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const awake = current;
        if (!awake || closed) return;
        lastRunStartedAt = now();
        try {
          const ready = (awake.ready ??= track(catchUp(awake)));
          await ready.catch((error: unknown) => {
            if (awake.ready === ready) delete awake.ready;
            throw error;
          });
          const caughtUp = await awake.attached.recover();
          if (closed) return;
          const more = caughtUp && (await acceptIntents(store, awake.worker, []));
          if (caughtUp && !closed) await awake.worker.drain();
          if (!caughtUp || more) again = true;
          failures = 0;
        } catch (error) {
          report(error);
          if (closed) return;
          failures++;
          arm(now() + failureDelay(failures));
          return;
        }
        if (again) await setImmediate();
      } while (again);
    })().finally(() => {
      running = undefined;
      if (state) arm(state.deadline);
    });
    return running;
  };
  const kick = () => {
    if (!active || closed || !current) return;
    arm(now());
  };

  // Stopping an idle worker. Calls that arrive meanwhile wait, then start a fresh one.
  let cancelSleep: (() => void) | undefined;
  const disarmSleep = () => {
    cancelSleep?.();
    cancelSleep = undefined;
  };
  const armSleep = () => {
    if (!active || closed || cancelSleep) return;
    cancelSleep = delay(() => {
      cancelSleep = undefined;
      const awake = current;
      if (!awake || closed || !state?.idle) return;
      const busy = running !== undefined || calls > 0 || awake.ready === undefined;
      if (!maySleep({ idle: true, connected: connected().length, busy })) {
        armSleep();
        return;
      }
      current = undefined;
      state = undefined;
      sleptAt = now();
      cancelTimer?.();
      cancelTimer = undefined;
      timerAt = Number.POSITIVE_INFINITY;
      sleeping = (async () => {
        try {
          await awake.ready?.catch(() => {});
          await awake.attached.close();
          // The boundary lets the next start tell this sleep apart from a crash.
          await awake.worker.sleep();
          await awake.worker.close();
        } catch (error) {
          report(error);
        }
      })().finally(() => {
        sleeping = undefined;
      });
    }, quietMs);
  };

  // Agent notices raise no event the worker reads, so the daemon wakes delivery for them.
  const stopNotices = store.subscribe((events) => {
    if (!active || closed || !events.some(isNotice)) return;
    if (current) kick();
    else if (sleptAt !== undefined)
      void dropIntents(store, { after: sleptAt, before: now() - deliverableFor(windowMs) }).catch(
        report,
      );
  });

  const use = async <T>(call: (worker: NotificationWorker) => Promise<T>): Promise<T> => {
    calls++;
    try {
      return await call((await awaken()).worker);
    } finally {
      calls--;
    }
  };
  /** Calls with nothing to do while stopped: presence is gone, revocations replay on start. */
  const ifAwake = async (call: (worker: NotificationWorker) => Promise<void>): Promise<void> => {
    if (current) await use(call);
  };
  const service: NotificationAccess = {
    cursor: (abort) => use((worker) => worker.cursor(abort)),
    ingest: (events, coverage) => use((worker) => worker.ingest(events, coverage)),
    connectDevice: (device) => use((worker) => worker.connectDevice(device)),
    register: (device, address) => use((worker) => worker.register(device, address)),
    unregister: (device) => use((worker) => worker.unregister(device)),
    getPreferences: (device) => use((worker) => worker.getPreferences(device)),
    preferences: (device, input) => use((worker) => worker.preferences(device, input)),
    notify: (notification) => use((worker) => worker.notify(notification)),
    snooze: (thread, until) => use((worker) => worker.snooze(thread, until)),
    updatePresence: (session, device, update) =>
      use((worker) => worker.updatePresence(session, device, update)),
    feed: (device, afterCursor) => use((worker) => worker.feed(device, afterCursor)),
    disconnect: (session) => ifAwake((worker) => worker.disconnect(session)),
    revoke: (device, abort) => ifAwake((worker) => worker.revoke(device, abort)),
    drain: () => use((worker) => worker.drain()),
    close: () => close(),
  };

  const activate = () => {
    cancelled();
    if (active) return;
    active = true;
    if (current) void run();
  };
  let stopped: Promise<void> | undefined;
  const stop = () => {
    closed = true;
    deliveryLifetime.abort();
    cancelTimer?.();
    disarmSleep();
    stopNotices();
    const awake = current;
    stopped ??= (async () => {
      await sleeping;
      await awake?.attached.close();
      // Settle startup RPC continuations before the worker enters its closing state.
      await Promise.allSettled(startups);
    })();
  };
  const close = async () => {
    const awake = current;
    stop();
    await stopped;
    await awake?.worker.close();
  };
  return {
    stop,
    service,
    async open() {
      await (current ??= begin()).opened;
    },
    async ready() {
      await awaken();
    },
    tick: run,
    activate,
    setSender(sender) {
      send = sender;
    },
    setConnected(list) {
      connected = list;
    },
    async start() {
      await awaken();
      activate();
    },
    close,
  };
}
