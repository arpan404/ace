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
  type QuotaReader,
} from "@ace/usage";
import type { Store } from "./store.ts";
import { includeUsageAccounts } from "./usage-accounts.ts";

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
/** Failed background replay retries 1 s, 2 s, 4 s ... capped, then waits for new data. */
export const usageReplayBackoff = { baseMs: 1000, capMs: 300_000, attempts: 12 };
const defaultReplayTimer = {
  delay(run: () => void, milliseconds: number): () => void {
    const timer = setTimeout(run, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
export function createDaemonUsage(
  dataDir: string,
  store: Pick<Store, "subscribeUsage" | "readUsagePage">,
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
  const sink = {
    async cursor() {
      cursor ??= await worker.cursor();
      return cursor;
    },
    async ingest(batch: Parameters<UsageWorker["ingest"]>[0]) {
      cursor = undefined;
      cursor = await worker.ingest(batch);
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
  const unsubscribe = store.subscribeUsage(schedule);
  const query = async (kind: "summary" | "series", input: UsageQuery) => {
    if (stopped) throw new Error("Usage service closed");
    const parsed = UsageQuery.parse(input);
    let result = await worker[kind](parsed);
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
      await catchUp();
      return UsageSessionTotalPage.parse(await worker.sessionTotalsFor(request));
    },
    catchUp,
    async start() {
      await sink.cursor();
      // The append subscription wakes new data; only a failed replay keeps a retry timer.
      schedule();
    },
    async close() {
      stopped = true;
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
