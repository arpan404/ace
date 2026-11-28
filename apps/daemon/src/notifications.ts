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
import type { ActivitySender, PushGatewayTarget } from "@ace/notify";
import { createActivityDelivery } from "./notification-activity-delivery.ts";
import { activeDevice, allows } from "./devices.ts";
import { createAckTracker } from "./notification-ack.ts";
import {
  createLiveActivityRegistrar,
  type LiveActivityGateway,
} from "./notification-live-activity.ts";
import { failureDelay, maySleep, wakeDelay } from "./notification-wake.ts";
import type { Store } from "./store.ts";
import { acceptIntents, dropIntents, isNotice } from "./notification-intents.ts";
import { delegatedHere } from "./notification-ownership.ts";

const offline = () => false;
const nobody = (): readonly DeviceId[] => [];

/** The worker's calls. The daemon starts the worker on the first one that needs it. */
export type NotificationAccess = Pick<
  NotificationWorker,
  | "cursor"
  | "ingest"
  | "connectDevice"
  | "pushAddresses"
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
  | "syncLiveActivity"
  | "liveActivityTargets"
  | "clearLiveActivity"
  | "dropLiveActivityToken"
  | "drain"
  | "close"
> & {
  /** A phone took a live `notification` frame; waiting deliveries may skip the push. */
  acknowledge(device: DeviceId, id: string): void;
  /** `notifications.remotePush` changed: off clears the tokens, on registers what is stored. */
  liveActivitySetting(enabled: boolean): Promise<void>;
};
export interface DaemonNotifications {
  service: NotificationAccess;
  setSender(sender: (device: DeviceId, notification: Notification) => boolean): void;
  /** Devices with a live socket; while any is connected the worker stays up. */
  setConnected(connected: () => readonly DeviceId[]): void;
  /** Whether saved notification state needs the worker from startup (see `notificationsRetained`). */
  open(): Promise<void>;
  ready(): Promise<void>;
  tick(): Promise<void>;
  /** Starts delivering. Calling it again changes nothing. */
  activate(): void;
  start(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
interface Runtime {
  signal?: AbortSignal;
  spawn?: ConstructorParameters<typeof NotificationWorker>[0]["spawn"];
  now?: () => number;
  /** Elapsed time, for intervals a clock someone sets must not stretch or cut short. */
  monotonic?: () => number;
  delay?: (run: () => void, milliseconds: number) => () => void;
  /** How long an idle worker stays up before it stops. */
  quietMs?: number;
  /**
   * Nothing needed the worker when the daemon started (see `notificationsRetained`), so the
   * daemon runs without one from the log's current head: events after it count as slept
   * through. Events before it (a crash, say) are delivered normally.
   */
  slept?: boolean;
  /**
   * Live Activity tokens to the push gateway (ADR 0223). Absent where no gateway is configured:
   * a phone's tokens are then not stored, and #2760 has nothing to push with.
   */
  liveActivity?: {
    /** With `sendActivity` (ace's gateway), the machine's state is pushed to each activity. */
    gateway: LiveActivityGateway & Partial<ActivitySender>;
    /** The push switch and gateway origin, read live (ADR 0106). */
    target: () => PushGatewayTarget | Promise<PushGatewayTarget>;
    /** Where Live Activities may not be used at all, such as an organization's host. */
    allowed?: () => boolean | Promise<boolean>;
    /** Whether an id that synced a token still holds a current pairing with read access. */
    authorize?: (devices: readonly DeviceId[]) => boolean;
  };
}
interface Awake {
  worker: NotificationWorker;
  attached: ReturnType<typeof attachNotifications>;
  alertsFrom: number;
  /** The first worker's first reply, for startup. Recovery asks whichever worker is current. */
  opened: Promise<void>;
  ready?: Promise<void>;
  /** Which `ready` a successful Live Activity resume covered; a restart resumes again. */
  resumedFor?: Promise<void> | undefined;
  resumingFor?: Promise<void> | undefined;
  resuming?: Promise<void>;
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
  const monotonic = runtime.monotonic ?? (() => performance.now());
  const delay = runtime.delay ?? unrefDelay;
  const quietMs = runtime.quietMs ?? 60_000;
  let send: (device: DeviceId, notification: Notification) => boolean = offline;
  let connected = nobody;
  /**
   * Phones with a push address prove they are awake: the live frame goes to their foreground
   * sockets and the router falls through to the gateway unless `notification.ack` arrives in
   * time. A suspended app can keep its socket open, so a sent frame alone is no delivery.
   */
  const acks = createAckTracker(runtime.delay ?? unrefDelay);
  const delivery = createNotificationRouter({
    ...channels,
    websocket: (device, notification) => send(device, notification),
    acknowledged: async (device, notification) => {
      if (!send(device, notification)) return false;
      return acks.wait(device, notification.id);
    },
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
      onRestart: () => {
        if (current?.worker !== worker) return;
        // A restarted worker may have lost or replayed store state: catch up and let the
        // Live Activity resume replay unconfirmed cleanup before anything registers again.
        delete current.ready;
        kick();
      },
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
        // Once replay has every thread, before anything is delivered: threads a paired machine
        // delegated here alert nobody here, whether or not this store saw the event saying so.
        for (const threads of delegatedHere(store)) {
          await awake.worker.markRemote(threads, signal);
          cancelled();
        }
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
  let resumeFailures = 0;
  let cancelResumeRetry: (() => void) | undefined;
  /** A failed cleanup is retried detached with backoff; a later run does not hammer it. */
  const scheduleResumeRetry = (awake: Awake) => {
    // A resume that succeeded earlier no longer covers this failure: the retry must run it.
    delete awake.resumedFor;
    if (closed || cancelResumeRetry) return;
    resumeFailures++;
    cancelResumeRetry = delay(() => {
      cancelResumeRetry = undefined;
      if (closed || current !== awake) return;
      resumeOnce(awake).catch(report);
    }, failureDelay(resumeFailures));
  };
  /**
   * Once a catch-up succeeded, replay unconfirmed cleanup and register activity tokens. It is
   * never awaited by a cold worker acquisition: a cleanup's own worker RPC may be what wakes
   * the worker, and resume would otherwise wait on the write queue it is holding. The delivery
   * run awaits it instead; failures retry on their own bounded lane.
   */
  const resumeOnce = (awake: Awake): Promise<void> => {
    const ready = awake.ready;
    if (!ready) return Promise.resolve();
    if (awake.resumedFor === ready) return Promise.resolve();
    if (cancelResumeRetry) return Promise.resolve();
    if (awake.resumingFor === ready) return awake.resuming ?? Promise.resolve();
    awake.resumingFor = ready;
    const resuming = ready
      .then(() => resumeLiveActivity())
      .then((done) => {
        if (done) {
          awake.resumedFor = ready;
          resumeFailures = 0;
        } else scheduleResumeRetry(awake);
      })
      .catch((error: unknown) => {
        report(error);
        scheduleResumeRetry(awake);
      })
      .finally(() => {
        if (awake.resuming === resuming) {
          delete awake.resuming;
          delete awake.resumingFor;
        }
      });
    awake.resuming = resuming;
    return resuming;
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
      void run().catch(report);
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
          await resumeOnce(awake);
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
  /**
   * Unregister or revoke work the worker did not confirm. The device stays fenced, so none of
   * its tokens are used, until a restart or recovery replays the cleanup successfully.
   */
  const pendingCleanups = new Map<string, { device: DeviceId; run: () => Promise<void> }>();
  const replayCleanups = async (): Promise<boolean> => {
    for (const [key, entry] of pendingCleanups) {
      try {
        await entry.run();
        await registrar?.forgetMissing();
      } catch (error) {
        report(error);
        return false;
      }
      pendingCleanups.delete(key);
      registrar?.clearFence(entry.device);
    }
    return true;
  };
  const cleanupDevice = async (device: DeviceId, cleanup: () => Promise<void>): Promise<void> => {
    // Fenced before the call: a slow or failing cleanup never leaves the tokens usable.
    registrar?.fenceDevice(device);
    const key = String(device);
    try {
      await cleanup();
      await registrar?.forgetMissing();
    } catch (error) {
      pendingCleanups.set(key, { device, run: cleanup });
      // The retry lane replays it even if no worker restart follows this failure.
      if (current) scheduleResumeRetry(current);
      throw error;
    }
    pendingCleanups.delete(key);
    registrar?.clearFence(device);
  };
  const resumeLiveActivity = async (): Promise<boolean> => {
    if (!registrar) return true;
    if (!(await replayCleanups())) return false;
    try {
      await registrar.resume();
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };
  /** Live Activity tokens and their gateway handles, when a gateway is configured. */
  const registrar = runtime.liveActivity
    ? createLiveActivityRegistrar({
        tokens: {
          sync: (device, linked, input) =>
            use((worker) => worker.syncLiveActivity(device, linked, input)),
          targets: () => use((worker) => worker.liveActivityTargets()),
          clear: () => use((worker) => worker.clearLiveActivity()),
          drop: (address) => use((worker) => worker.dropLiveActivityToken(address)),
        },
        gateway: runtime.liveActivity.gateway,
        target: runtime.liveActivity.target,
        ...(runtime.liveActivity.allowed ? { allowed: runtime.liveActivity.allowed } : {}),
        authorize:
          runtime.liveActivity.authorize ??
          // A record the store no longer holds is an account-only alias, authorized elsewhere.
          ((devices) =>
            devices.some((id) => {
              const paired = store.devices.get(id);
              return (
                paired === undefined || (activeDevice(paired, now()) && allows(paired, "read"))
              );
            })),
        now,
        signal,
        report,
        delay,
        cleanupFailed: () => {
          if (current) scheduleResumeRetry(current);
        },
      })
    : undefined;
  const activitySender = runtime.liveActivity?.gateway;
  /** Pushes this machine's state to each phone's Live Activity and ends it once settled (#2760). */
  const activity =
    registrar && activitySender?.sendActivity
      ? createActivityDelivery({
          store,
          gateway: { sendActivity: activitySender.sendActivity.bind(activitySender) },
          targets: () => registrar.sendTargets(),
          guard: () => (target) => registrar.eligible(target),
          drop: (target) => registrar.drop(target),
          requestSignal: () => deliveryLifetime.signal,
          preferences: (device) => use((worker) => worker.getPreferences(device)),
          now,
          monotonic,
          delay,
          report,
          signal,
        })
      : undefined;
  /** The stored tokens changed: the delivery lane reads them again. */
  const tokensChanged = <T>(result: Promise<T>): Promise<T> =>
    result.finally(() => activity?.refresh());
  const service: NotificationAccess = {
    cursor: (abort) => use((worker) => worker.cursor(abort)),
    ingest: (events, coverage) => use((worker) => worker.ingest(events, coverage)),
    connectDevice: (device) => use((worker) => worker.connectDevice(device)),
    pushAddresses: (devices) => use((worker) => worker.pushAddresses(devices)),
    register: (device, address) => use((worker) => worker.register(device, address)),
    unregister: (device) => cleanupDevice(device, () => use((worker) => worker.unregister(device))),
    getPreferences: (device) => use((worker) => worker.getPreferences(device)),
    preferences: (device, input) => use((worker) => worker.preferences(device, input)),
    notify: (notification) => use((worker) => worker.notify(notification)),
    snooze: (thread, until) =>
      use((worker) => worker.snooze(thread, until)).finally(() => activity?.snooze(thread)),
    updatePresence: (session, device, update) =>
      use((worker) => worker.updatePresence(session, device, update)),
    acknowledge: (device, id) => {
      acks.resolve(device, id);
    },
    feed: (device, afterCursor, checkpoint, linked) =>
      use((worker) => worker.feed(device, afterCursor, checkpoint, linked)),
    disconnect: (session) => ifAwake((worker) => worker.disconnect(session)),
    revoke: (device, abort) => {
      if (!current) return Promise.resolve();
      return cleanupDevice(device, () => use((worker) => worker.revoke(device, abort)));
    },
    syncLiveActivity: (device, linked, input) =>
      registrar
        ? tokensChanged(registrar.sync(device, linked, input))
        : use((worker) => worker.syncLiveActivity(device, linked, input)),
    liveActivityTargets: () => (registrar ? registrar.targets() : Promise.resolve([])),
    clearLiveActivity: () =>
      registrar ? tokensChanged(registrar.clear()) : use((worker) => worker.clearLiveActivity()),
    dropLiveActivityToken: (address) =>
      registrar
        ? tokensChanged(registrar.drop(address))
        : use((worker) => worker.dropLiveActivityToken(address)),
    liveActivitySetting: (enabled) => {
      if (!registrar) return Promise.resolve();
      return tokensChanged(enabled ? registrar.resume() : registrar.clear());
    },
    drain: () => use((worker) => worker.drain()),
    close: () => close(),
  };

  const activate = () => {
    cancelled();
    if (active) return;
    active = true;
    if (current) void run().catch(report);
    activity?.refresh();
  };
  let stopped: Promise<void> | undefined;
  const stop = () => {
    closed = true;
    pendingCleanups.clear();
    cancelResumeRetry?.();
    cancelResumeRetry = undefined;
    registrar?.stop();
    activity?.stop();
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
    async tick() {
      await run();
      await activity?.run();
    },
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
