import type { IdleWorkerRuntime } from "@ace/provider-kit/idle-worker";
import { open } from "node:fs/promises";
import { z } from "zod";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  UsageQuery,
  UsageResult,
  UsageSessionTotalsQuery,
  UsageSessionTotalPage,
} from "@ace/protocol";
import {
  UsageWorker,
  UsageSettings,
  QuotaWindow,
  backfillBatch,
  SessionTotalsFold,
  type QuotaReader,
} from "@ace/usage";
import type { Store } from "./store.ts";
import { includeUsageAccounts } from "./usage-accounts.ts";
import type { UsageReplay } from "./usage-replay.ts";

export interface UsageCommands {
  subscribeLimits?(
    listener: (
      account: import("zod").infer<typeof import("@ace/protocol/accounts").AccountSummary>,
    ) => void,
  ): () => void;
  summary(query: UsageQuery): Promise<UsageResult>;
  series(query: UsageQuery): Promise<UsageResult>;
  sessionTotals?(
    query: UsageSessionTotalsQuery,
  ): Promise<import("zod").infer<typeof UsageSessionTotalPage>>;
}
export async function loadUsageSettings(dataDir: string): Promise<UsageSettings> {
  let file;
  try {
    file = await open(
      join(dataDir, "usage-settings.json"),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return UsageSettings.parse({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error("Usage settings must be a regular file");
    const bytes = Buffer.alloc(128 * 1024 + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset === bytes.length) throw new Error("Usage settings exceed 128 KiB");
    return UsageSettings.parse({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(bytes.subarray(0, offset).toString("utf8"))),
    });
  } finally {
    await file.close();
  }
}
/** What one failed background replay reports; each backoff step reports once. */
export interface UsageReplayFailure {
  attempt: number;
  /** When the next attempt runs, or null once replay waits for new usage data. */
  retryInMs: number | null;
}
/**
 * The most events behind a read's head that the read waits for the replay to project, up to
 * `usageSettleMs`. Live use keeps the replay within a page or two. Further behind, a read doesn't
 * wait: summaries answer marked as still filling in, and inclusive session totals are folded from
 * the thread's own events.
 */
export const usageFillingBacklog = 4096;
/** How long a read waits for the replay to reach the head it captured. */
export const usageSettleMs = 250;
/** A thread's events read per main-thread slice when its session totals are read directly. */
const sessionSliceEvents = 256;
/** Failed background replay retries 1 s, 2 s, 4 s ... capped, then waits for new data. */
export const usageReplayBackoff = { baseMs: 1000, capMs: 300_000, attempts: 12 };
const defaultReplayTimer = {
  delay(run: () => void, milliseconds: number): () => void {
    const timer = setTimeout(run, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
/** The event store reads usage makes: the replay's pages and one thread's session samples. */
export type UsageHistory = Pick<
  Store,
  "subscribeUsage" | "readUsagePage" | "headSeq" | "flushLiveWrites"
> & { readonly usageReplay: Pick<UsageReplay, "readSessionUsage"> };
export function createDaemonUsage(
  dataDir: string,
  store: UsageHistory,
  settings: UsageSettings,
  onError: (error: unknown, failure?: UsageReplayFailure) => void,
  accounts?: QuotaReader,
  now: () => number = Date.now,
  providerAccounts?: Pick<import("@ace/accounts").AccountService, "handle" | "subscribeQuota">,
  runtime?: IdleWorkerRuntime,
  replayTimer: { delay(run: () => void, milliseconds: number): () => void } = defaultReplayTimer,
) {
  const worker = new UsageWorker(join(dataDir, "usage.sqlite"), settings, runtime);
  // The worker owns the durable cursor, and only this replay advances it. Remembering its
  // last answer lets a store commit with no new events skip waking a retired isolate.
  let cursor: number | undefined;
  // The furthest a committed page has reached, and reads waiting for it to reach their head.
  let committed = 0;
  const waiting = new Set<{ target: number; done(reached: boolean): void }>();
  const advance = (next: number) => {
    committed = Math.max(committed, next);
    for (const entry of waiting) if (committed >= entry.target) entry.done(true);
  };
  const sink = {
    async cursor() {
      cursor ??= await worker.cursor();
      advance(cursor);
      return cursor;
    },
    async ingest(batch: Parameters<UsageWorker["ingest"]>[0]) {
      cursor = undefined;
      cursor = await worker.ingest(batch);
      advance(cursor);
      return cursor;
    },
  };
  let stopped = false;
  let failures = 0;
  let retry: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let scheduled: NodeJS.Immediate | undefined;
  let counted: unknown;
  const replay = () => {
    void catchUp().catch((error: unknown) => {
      // Wakeups that joined one failed pass share its error: it is one backoff step.
      if (stopped || error === counted) return;
      counted = error;
      failures++;
      const { baseMs, capMs, attempts } = usageReplayBackoff;
      const wait = failures > attempts ? null : Math.min(capMs, baseMs * 2 ** (failures - 1));
      onError(error, { attempt: failures, retryInMs: wait });
      if (wait !== null) arm(wait);
    });
  };
  const arm = (milliseconds: number) => {
    retry?.();
    retry = replayTimer.delay(() => {
      retry = undefined;
      replay();
    }, milliseconds);
  };
  /** New usage data wakes replay at once, unless a failing replay is backing off. */
  const schedule = () => {
    if (stopped || scheduled || retry) return;
    if (failures > usageReplayBackoff.attempts) {
      // Replay gave up on its bound: new data earns one more attempt per cap window.
      arm(usageReplayBackoff.capMs);
      return;
    }
    if (failures > 0) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      replay();
    });
  };
  const catchUp = (): Promise<void> => {
    if (stopped) return Promise.reject(new Error("Usage service closed"));
    if (running) return running;
    running = (async () => {
      while (await backfillBatch(sink, store)) {
        if (stopped) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })()
      .then(() => {
        failures = 0;
        retry?.();
        retry = undefined;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  /**
   * Whether the replay projects everything through `target` (a head the read captured) within
   * `usageSettleMs`. It never follows a moving head and never waits on a far backlog; a failing
   * page just lets the wait run out.
   */
  const reach = (target: number): Promise<boolean> => {
    if (committed >= target) return Promise.resolve(true);
    if (stopped || target - committed > usageFillingBacklog) return Promise.resolve(false);
    return new Promise((resolve) => {
      let cancel: (() => void) | undefined;
      const entry = {
        target,
        done(reached: boolean) {
          waiting.delete(entry);
          cancel?.();
          resolve(reached);
        },
      };
      waiting.add(entry);
      cancel = replayTimer.delay(() => entry.done(false), usageSettleMs);
      schedule();
    });
  };
  const unsubscribe = store.subscribeUsage(schedule);
  const query = async (kind: "summary" | "series", input: UsageQuery) => {
    if (stopped) throw new Error("Usage service closed");
    const parsed = UsageQuery.parse(input);
    const head = store.headSeq();
    await reach(head);
    let result = await worker[kind](parsed);
    // Marked until everything committed when the read began is counted: the totals will grow.
    if (result.cursor < head) result = { ...result, filling: { through: result.cursor, head } };
    if (providerAccounts && (parsed.filters.provider || parsed.filters.account)) {
      const response = await providerAccounts.handle({ type: "accounts.list", requestId: "usage" });
      if (response.type === "accounts.list")
        result = includeUsageAccounts(result, parsed, response.accounts);
    }
    if (parsed.quotaAccount && accounts) {
      const windows = await accounts.windows(parsed.quotaAccount);
      if (windows.length > 20) throw new Error("Too many quota windows");
      const at = now();
      result.burn = [];
      for (const window of windows)
        result.burn.push(await worker.burn(parsed.quotaAccount, QuotaWindow.parse(window), at));
    }
    return UsageResult.parse(result);
  };
  return {
    ...(providerAccounts
      ? {
          subscribeLimits: (listener: Parameters<typeof providerAccounts.subscribeQuota>[0]) =>
            providerAccounts.subscribeQuota(listener),
        }
      : {}),
    summary: (input: UsageQuery) => query("summary", input),
    series: (input: UsageQuery) => query("series", input),
    async sessionTotals(input: UsageSessionTotalsQuery) {
      const request = UsageSessionTotalsQuery.parse(input);
      if (stopped) throw new Error("Usage service closed");
      if (await reach(store.headSeq()))
        return UsageSessionTotalPage.parse(await worker.sessionTotalsFor(request));
      // The replay is behind this read's head: fold this thread's own samples by the
      // projection's rule rather than wait for history. Nothing is written, so nothing counts
      // twice. The thread is read and folded in index-bounded slices, yielding between them.
      const fold = new SessionTotalsFold(request);
      try {
        store.flushLiveWrites();
        for (let after = 0; ;) {
          const slice = store.usageReplay.readSessionUsage(
            request.thread,
            after,
            sessionSliceEvents,
          );
          if (slice.throughSeq === null) break;
          fold.add(slice.events);
          after = slice.throughSeq;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (stopped) throw new Error("Usage service closed");
        }
        return UsageSessionTotalPage.parse(fold.list());
      } finally {
        fold.close();
      }
    },
    catchUp,
    async start() {
      await sink.cursor();
      // The append subscription wakes new data; only a failed replay keeps a retry timer.
      schedule();
    },
    async close() {
      stopped = true;
      for (const entry of waiting) entry.done(false);
      unsubscribe();
      retry?.();
      retry = undefined;
      if (scheduled) clearImmediate(scheduled);
      try {
        await running;
      } finally {
        await worker.close();
      }
    },
  };
}
