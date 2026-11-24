import {
  activityDecision,
  secondOf,
  type ActivitySchedule,
  type ActivitySender,
  type LiveActivityTarget,
} from "@ace/notify";
import { isQuiet } from "@ace/notify/policy";
import type { DeviceId, NotificationPreferences, ThreadId } from "@ace/protocol";
import { activityJournal } from "./notification-activity-journal.ts";
import { activityState, type ActivitySnapshot } from "./notification-activity-state.ts";
import { failureDelay } from "./notification-wake.ts";
import type { Store } from "./store.ts";

type Last = NonNullable<ActivitySchedule["last"]>;
type Decision = Extract<ReturnType<typeof activityDecision>, { event: string }>;
const unavailableMs = 60 * 60_000;
const rereadMs = 1000;
const keyOf = (target: LiveActivityTarget) => `${target.environment}\n${target.token}`;

interface Options {
  store: Store;
  gateway: ActivitySender;
  targets(): Promise<LiveActivityTarget[]>;
  guard(): (target: LiveActivityTarget) => boolean;
  drop(target: LiveActivityTarget): Promise<void>;
  requestSignal(target: LiveActivityTarget): AbortSignal;
  preferences(device: DeviceId): Promise<NotificationPreferences>;
  now: () => number;
  delay: (run: () => void, milliseconds: number) => () => void;
  report(error: unknown): void;
  signal: AbortSignal;
}

interface Stream {
  target: LiveActivityTarget;
  doneAtJoin: number;
  ended: boolean;
  last?: Last;
  attemptedAt?: number;
  rejectedEnd?: number;
  previousNeedsSnoozed?: boolean;
  prefs?: readonly NotificationPreferences[];
  retryAt?: number;
  failures: number;
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
  const streams = new Map<string, Stream>();
  const completions: number[] = [];
  const facts = activityState(store, now, (seq) => completions.push(seq));
  let journal: ReturnType<typeof activityJournal> | undefined;
  let generation = 0;
  let loaded = -1;
  let running: Promise<void> | undefined;
  let again = false;
  let cancelTimer: (() => void) | undefined;
  let deadline = Infinity;
  let closed = false;
  let completionCount = 0;

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
      Math.max(0, at - now()),
    );
  };
  const refresh = () => {
    generation++;
    arm(now());
  };
  const stopEvents = store.subscribe((events) => {
    if (streams.size > 0 && facts.changed(events)) arm(now());
  });
  const stopReads = store.onThreadRead(() => {
    if (streams.size > 0) arm(now());
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
    if (targets.length > 0) journal ??= activityJournal(store);
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
      arm(now() + 10);
      return undefined;
    }
    state.counts.done = Math.min(999, Math.max(0, completionCount - stream.doneAtJoin));
    return state;
  }

  function decide(stream: Stream, state: ActivitySnapshot, at: number): Decision | undefined {
    if (state.settledSince !== undefined && stream.rejectedEnd === state.settledSince) return;
    const attemptedAt = stream.attemptedAt ?? journal?.bootAttemptedAt;
    const next = activityDecision({
      ...state,
      now: at,
      frequentUpdates: stream.target.frequentUpdates,
      quiet: snoozed(state, stream) || (stream.prefs?.some((prefs) => isQuiet(prefs, at)) ?? false),
      ...(stream.last ? { last: stream.last } : {}),
      // If the clock was set back while stopped, leave one second before the restart push.
      ...(attemptedAt === undefined
        ? {}
        : {
            attemptedAt:
              Math.min(attemptedAt, bootAt) === bootAt && stream.attemptedAt === undefined
                ? bootAt
                : attemptedAt,
          }),
      ...(stream.retryAt === undefined ? {} : { retryAt: stream.retryAt }),
    });
    if (next && "at" in next) {
      arm(next.at);
      return;
    }
    return next;
  }

  async function deliver(
    stream: Stream,
    eligible: (target: LiveActivityTarget) => boolean,
  ): Promise<void> {
    const target = stream.target;
    if (!journal || !eligible(target)) return;
    if (stream.ended) {
      if (stream.retryAt !== undefined && stream.retryAt > now()) {
        arm(stream.retryAt);
        return;
      }
      await options.drop(target);
      streams.delete(keyOf(target));
      return;
    }
    stream.prefs ??= await Promise.all(target.devices.map((device) => options.preferences(device)));
    if (closed || !eligible(target)) return;
    const state = snapshot(stream);
    if (!state) return;
    const at = now();
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
        const clock = now();
        const next = decide(stream, latest, clock);
        if (!next || !journal) return;
        const { seq, timestamp } = journal.reserve(clock);
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
            at: secondOf(clock),
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
          now() +
          (result.status === "retry" && result.retryAfterMs !== undefined
            ? Math.max(rereadMs, result.retryAfterMs)
            : result.status === "unsupported"
              ? unavailableMs
              : failureDelay(stream.failures));
        arm(stream.retryAt);
    }
  }

  const open = () => !closed && !signal.aborted;
  const bootAt = now();
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
                  stream.retryAt = now() + failureDelay(stream.failures);
                  arm(stream.retryAt);
                }
              }),
            );
        } catch (error) {
          report(error);
          loaded = -1;
          arm(now() + rereadMs);
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
      if (streams.size > 0) arm(now());
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
