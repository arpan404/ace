import {
  activityDecision,
  secondOf,
  type ActivitySchedule,
  type ActivitySender,
} from "@ace/notify";
import { isQuiet } from "@ace/notify/policy";
import type { DeviceId, NotificationPreferences, ThreadId } from "@ace/protocol";
import { activityJournal } from "./notification-activity-journal.ts";
import { activityState, type ActivitySnapshot } from "./notification-activity-state.ts";
import type { LiveActivitySendTarget } from "./notification-live-activity.ts";
import { failureDelay } from "./notification-wake.ts";
import type { Store } from "./store.ts";

type Last = NonNullable<ActivitySchedule["last"]>;
type Decision = Extract<ReturnType<typeof activityDecision>, { event: string }>;
const unavailableMs = 60 * 60_000;
const rereadMs = 1000;
const keyOf = (target: LiveActivitySendTarget) => `${target.environment}\n${target.token}`;

interface Options {
  store: Store;
  /**
   * Whether a child this machine delegated to another one is still watched. Polling can't prove
   * such a child stayed quiet, so the end waits until none is.
   */
  remoteWatched?: () => boolean;
  gateway: ActivitySender;
  targets(): Promise<LiveActivitySendTarget[]>;
  guard(): (target: LiveActivitySendTarget) => boolean;
  drop(target: LiveActivitySendTarget): Promise<void>;
  requestSignal(target: LiveActivitySendTarget): AbortSignal;
  preferences(device: DeviceId): Promise<NotificationPreferences>;
  /** Wall time: quiet hours, snoozes and what goes on the wire. */
  now: () => number;
  /** Elapsed time for every interval: the quiet grace, spacing, throttles and retries. */
  monotonic: () => number;
  delay: (run: () => void, milliseconds: number) => () => void;
  report(error: unknown): void;
  signal: AbortSignal;
}

/** Every time in a stream is on the elapsed clock. */
interface Stream {
  target: LiveActivitySendTarget;
  doneAtJoin: number;
  ended: boolean;
  last?: Last;
  attemptedAt?: number;
  rejectedEnd?: number;
  previousNeedsSnoozed?: boolean;
  prefs?: readonly NotificationPreferences[];
  retryAt?: number;
  failures: number;
  /** The lane's `changes` when the remote-children gate last held this stream's end. */
  heldAt?: number;
}

function snoozed(state: ActivitySnapshot, stream: Stream) {
  const last = stream.last?.counts;
  if (!last) return state.workSnoozed;
  const { needsYou, failed } = state.counts;
  const moreAsking = needsYou > last.needsYou;
  const moreFailed = failed > last.failed;
  const cleared = needsYou === 0 && last.needsYou > 0;
  if (moreAsking || moreFailed || cleared)
    return (
      (!moreAsking || state.needsYouSnoozed) &&
      (!moreFailed || state.failedSnoozed) &&
      (!cleared || stream.previousNeedsSnoozed === true)
    );
  return state.workSnoozed;
}

/** One delivery lane and deadline per machine. Transport delays never queue an old payload. */
export function createActivityDelivery(options: Options) {
  const { store, now, report, signal } = options;
  const elapsed = options.monotonic;
  const streams = new Map<string, Stream>();
  const completions: number[] = [];
  const facts = activityState(store, { now, elapsed }, (seq) => completions.push(seq));
  let journal: ReturnType<typeof activityJournal> | undefined;
  let generation = 0;
  let loaded = -1;
  let running: Promise<void> | undefined;
  let again = false;
  let cancelTimer: (() => void) | undefined;
  let deadline = Infinity;
  let closed = false;
  let completionCount = 0;
  /** Before the first push of this run: one second after the last push a past run recorded. */
  let firstPushAt = 0;

  const arm = (at: number) => {
    if (closed || signal.aborted || at >= deadline) return;
    cancelTimer?.();
    deadline = at;
    cancelTimer = options.delay(
      () => {
        deadline = Infinity;
        cancelTimer = undefined;
        void run().catch(report);
      },
      Math.max(0, at - elapsed()),
    );
  };
  /**
   * Counts what may change the activity's state: events, reads, new tokens, snoozes. A wake with
   * no change since an end was held only looks at the remote-children gate again.
   */
  let changes = 0;
  const refresh = () => {
    changes++;
    generation++;
    arm(elapsed());
  };
  const stopEvents = store.subscribe((events) => {
    if (streams.size > 0 && facts.changed(events)) {
      changes++;
      arm(elapsed());
    }
  });
  const stopReads = store.onThreadRead(() => {
    changes++;
    if (streams.size > 0) arm(elapsed());
  });

  function persistCompletions() {
    if (!journal) return;
    completionCount = journal.complete(completions);
    completions.length = 0;
  }

  async function loadTargets(): Promise<void> {
    if (loaded === generation) return;
    const asked = generation;
    const targets = (await options.targets()).filter((target) => target.kind === "liveactivity");
    if (closed || asked !== generation) return;
    loaded = asked;
    if (targets.length > 0 && !journal) {
      journal = activityJournal(store);
      // The past run's last push is in wall time. A clock set back since then waits one second.
      const wall = now();
      const nextSecond = (secondOf(Math.min(journal.bootAttemptedAt, wall)) + 1) * 1000;
      firstPushAt = elapsed() + Math.min(1000, Math.max(0, nextSecond - wall));
    }
    persistCompletions();
    const present = new Set(targets.map(keyOf));
    for (const key of streams.keys()) if (!present.has(key)) streams.delete(key);
    for (const target of targets) {
      const key = keyOf(target);
      const stream = streams.get(key);
      if (stream) {
        stream.target = target;
        delete stream.prefs;
      } else if (journal) {
        streams.set(key, { target, ...journal.join(target), failures: 0 });
      }
    }
    if (streams.size === 0) facts.reset();
  }

  function snapshot(stream: Stream): ActivitySnapshot | undefined {
    const state = facts.read(stream.target.devices);
    if (!state) {
      arm(elapsed() + 10);
      return undefined;
    }
    state.counts.done = Math.min(999, Math.max(0, completionCount - stream.doneAtJoin));
    return state;
  }

  function decide(stream: Stream, state: ActivitySnapshot, at: number): Decision | undefined {
    if (state.settledSince !== undefined && stream.rejectedEnd === state.settledSince) return;
    const wall = now();
    const retryAt = Math.max(
      stream.retryAt ?? 0,
      stream.attemptedAt === undefined ? firstPushAt : 0,
    );
    const next = activityDecision({
      ...state,
      now: at,
      frequentUpdates: stream.target.frequentUpdates,
      quiet:
        snoozed(state, stream) || (stream.prefs?.some((prefs) => isQuiet(prefs, wall)) ?? false),
      ...(stream.last ? { last: stream.last } : {}),
      ...(stream.attemptedAt === undefined ? {} : { attemptedAt: stream.attemptedAt }),
      ...(retryAt > 0 ? { retryAt } : {}),
    });
    if (next && "at" in next) {
      arm(next.at);
      return;
    }
    // A remote child may start again unseen: no end while one is watched. Looked at again on
    // this lane's own timer, a second from now.
    if (next?.event === "end" && options.remoteWatched?.()) {
      stream.heldAt = changes;
      arm(elapsed() + rereadMs);
      return;
    }
    return next;
  }

  async function deliver(
    stream: Stream,
    eligible: (target: LiveActivitySendTarget) => boolean,
  ): Promise<void> {
    const target = stream.target;
    if (!journal || !eligible(target)) return;
    if (stream.ended) {
      if (stream.retryAt !== undefined && stream.retryAt > elapsed()) {
        arm(stream.retryAt);
        return;
      }
      await options.drop(target);
      streams.delete(keyOf(target));
      return;
    }
    // Its end is held for a remote child and nothing has changed since: only the bounded gate is
    // looked at again (ADR 0170). The state is built once more when it opens.
    if (stream.heldAt === changes && options.remoteWatched?.()) {
      arm(elapsed() + rereadMs);
      return;
    }
    delete stream.heldAt;
    stream.prefs ??= await Promise.all(target.devices.map((device) => options.preferences(device)));
    if (closed || !eligible(target)) return;
    const state = snapshot(stream);
    if (!state) return;
    const at = elapsed();
    const decision = decide(stream, state, at);
    if (!decision) return;
    // Reserve order and recompute from committed state in the same synchronous turn as POST.
    // New work, pairing cleanup, or a setting change can happen while a handle is being fetched.
    let attempted: { state: ActivitySnapshot; decision: Decision; at: number } | undefined;
    const result = await options.gateway.sendActivity(
      target,
      () => {
        if (closed || !eligible(target)) return;
        persistCompletions();
        const latest = snapshot(stream);
        if (!latest) return;
        const clock = elapsed();
        const next = decide(stream, latest, clock);
        if (!next || !journal) return;
        const wall = now();
        const { seq, timestamp } = journal.reserve(wall);
        stream.attemptedAt = clock;
        attempted = { state: latest, decision: next, at: clock };
        const common = {
          v: 1 as const,
          timestamp,
          priority: next.priority,
          staleAfter: 900,
          state: {
            ...latest.counts,
            seq,
            at: secondOf(wall),
            phase: next.event === "end" ? ("settled" as const) : ("busy" as const),
          },
        };
        return next.event === "end"
          ? { ...common, event: "end", dismissAfter: 900 }
          : { ...common, event: "update" };
      },
      options.requestSignal(target),
    );

    if (closed || signal.aborted) return;
    switch (result.status) {
      case "skipped":
      case "disabled":
        return;
      case "gone":
        if (!eligible(target)) return;
        stream.ended = true;
        await options.drop(target);
        streams.delete(keyOf(target));
        return;
      case "sent":
      case "failed": {
        const delivered = attempted ?? { state, decision, at };
        stream.failures = 0;
        delete stream.retryAt;
        if (delivered.decision.event === "end") {
          if (result.status === "failed") {
            if (delivered.state.settledSince !== undefined)
              stream.rejectedEnd = delivered.state.settledSince;
            return;
          }
          // Record the accepted end before awaiting the token cleanup. A reconnect may still
          // present this token until the phone receives the end from APNs.
          journal.end(target, now());
          stream.ended = true;
          await options.drop(target);
          streams.delete(keyOf(target));
          return;
        }
        stream.last = { counts: delivered.state.counts, at: delivered.at };
        stream.previousNeedsSnoozed = delivered.state.needsYouSnoozed;
        again = true;
        return;
      }
      case "refresh":
      case "retry":
      case "unsupported":
        stream.failures++;
        stream.retryAt =
          elapsed() +
          (result.status === "retry" && result.retryAfterMs !== undefined
            ? Math.max(rereadMs, result.retryAfterMs)
            : result.status === "unsupported"
              ? unavailableMs
              : failureDelay(stream.failures));
        arm(stream.retryAt);
    }
  }

  const open = () => !closed && !signal.aborted;
  function run(): Promise<void> {
    if (closed || signal.aborted) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const eligible = options.guard();
        try {
          await loadTargets();
          if (closed || loaded !== generation) return;
          persistCompletions();
          const active = [...streams.values()];
          for (let index = 0; index < active.length; index += 4)
            await Promise.all(
              active.slice(index, index + 4).map(async (stream) => {
                try {
                  await deliver(stream, eligible);
                } catch (error) {
                  report(error);
                  stream.failures++;
                  stream.retryAt = elapsed() + failureDelay(stream.failures);
                  arm(stream.retryAt);
                }
              }),
            );
        } catch (error) {
          report(error);
          loaded = -1;
          arm(elapsed() + rereadMs);
          return;
        }
      } while (again && open());
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    run,
    refresh,
    snooze(_thread: ThreadId) {
      changes++;
      if (streams.size > 0) arm(elapsed());
    },
    stop() {
      closed = true;
      stopEvents();
      stopReads();
      cancelTimer?.();
      if (completions.length) {
        try {
          persistCompletions();
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
