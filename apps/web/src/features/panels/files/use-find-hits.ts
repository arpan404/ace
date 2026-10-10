import { contentHash } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { offThread } from "@/lib/off-thread.ts";
import { WorkQueue } from "@/lib/work-queue.ts";
import { findHits, type FindHit } from "./find-hits.ts";
type Input = { hash: string; query: string; text?: string };
const worker = offThread<Input, FindHit[] | null>({
  spawn: () =>
    new Worker(new URL("./find.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-file-find",
    }),
  local: (input) => (input.text === undefined ? null : findHits(input.text, input.query)),
  decode: (output) =>
    z
      .array(
        z.object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() }),
      )
      .nullable()
      .parse(output),
});
const jobs = new WorkQueue(
  async (input: Required<Input>, signal) => {
    if (signal.aborted) return [];
    const cached = await worker.run({ hash: input.hash, query: input.query }, signal);
    // The cache lookup may finish after its last view closed or the query changed. Avoid
    // cloning and searching the full file for a consumer that has already released its lease.
    if (signal.aborted) return [];
    return cached ?? (await worker.run(input, signal)) ?? [];
  },
  { jobs: 16, bytes: 16 * 1024 * 1024 },
);
const empty: FindHit[] = [];
export type FindStatus = "idle" | "pending" | "ready" | "failed";

/** Search stays off the render thread; stale searches cannot move the current file. */
export function useFindHits(text: string | undefined, query: string | undefined) {
  const hash = useMemo(() => (text === undefined ? "" : contentHash(text)), [text]);
  const key = `${hash}\u0000${query ?? ""}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    hits: FindHit[] | undefined;
  }>();
  useEffect(() => {
    if (text === undefined || !query) return;
    const lease = jobs.acquire(key, { hash, text, query }, text.length * 2);
    let live = true;
    void lease.result.then((hits) => {
      if (live) setResult({ key, attempt, hits });
    });
    return () => {
      live = false;
      lease.release();
    };
  }, [text, query, key, hash, attempt]);
  const current = result?.key === key && result.attempt === attempt ? result : undefined;
  const status: FindStatus =
    text === undefined || !query
      ? "idle"
      : current === undefined
        ? "pending"
        : current.hits === undefined
          ? "failed"
          : "ready";
  return { hits: current?.hits ?? empty, status, retry: () => setAttempt((value) => value + 1) };
}
