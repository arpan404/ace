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

/** Search stays off the render thread; stale searches cannot move the current file. */
export function useFindHits(text: string | undefined, query: string | undefined): FindHit[] {
  const hash = useMemo(() => (text === undefined ? "" : contentHash(text)), [text]);
  const key = `${hash}\u0000${query ?? ""}`;
  const [result, setResult] = useState<{ key: string; hits: FindHit[] }>();
  useEffect(() => {
    if (text === undefined || !query) return;
    const lease = jobs.acquire(key, { hash, text, query }, text.length * 2);
    let live = true;
    void lease.result.then((hits) => {
      if (live && hits) setResult({ key, hits });
    });
    return () => {
      live = false;
      lease.release();
    };
  }, [text, query, key, hash]);
  return result?.key === key ? result.hits : empty;
}
