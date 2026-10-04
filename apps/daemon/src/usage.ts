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

export interface UsageCommands {
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
export function createDaemonUsage(
  dataDir: string,
  store: Pick<Store, "subscribeUsage" | "readUsagePage">,
  settings: UsageSettings,
  onError: (error: unknown) => void,
  accounts?: QuotaReader,
  now: () => number = Date.now,
) {
  const worker = new UsageWorker(join(dataDir, "usage.sqlite"), settings);
  let stopped = false;
  let replayFailed = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let scheduled: NodeJS.Immediate | undefined;
  const schedule = () => {
    if (!stopped && !scheduled)
      scheduled = setImmediate(() => {
        scheduled = undefined;
        void catchUp().catch(onError);
      });
  };
  const catchUp = (): Promise<void> => {
    if (stopped) return Promise.reject(new Error("Usage service closed"));
    if (running) return running;
    running = (async () => {
      while (await backfillBatch(worker, store)) {
        if (stopped) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })()
      .then(
        () => {
          replayFailed = false;
        },
        (error: unknown) => {
          replayFailed = true;
          throw error;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const unsubscribe = store.subscribeUsage(schedule);
  const query = async (kind: "summary" | "series", input: UsageQuery) => {
    if (stopped) throw new Error("Usage service closed");
    const parsed = UsageQuery.parse(input);
    const result = await worker[kind](parsed);
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
    summary: (input: UsageQuery) => query("summary", input),
    series: (input: UsageQuery) => query("series", input),
    async sessionTotals(input: UsageSessionTotalsQuery) {
      const request = UsageSessionTotalsQuery.parse(input);
      await catchUp();
      return UsageSessionTotalPage.parse(await worker.sessionTotalsFor(request));
    },
    catchUp,
    async start() {
      await worker.cursor();
      schedule();
      // The append subscription wakes new data immediately; polling only recovers failed replay.
      timer = setInterval(() => {
        if (replayFailed) schedule();
      }, 1000);
      timer.unref();
    },
    async close() {
      stopped = true;
      unsubscribe();
      if (timer) clearInterval(timer);
      if (scheduled) clearImmediate(scheduled);
      try {
        await running;
      } finally {
        await worker.close();
      }
    },
  };
}
