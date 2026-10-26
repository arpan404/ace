import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

const admitted = z.object({ ok: z.literal(true), threadId: ThreadId });

test("concurrent ace runs from one home all start their threads, past the daemon's busy limit", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    // More runs than the daemon registers projects at once; each registers the project by path
    // and shares the home's CLI outbox with every other run.
    const runs = Array.from({ length: 20 }, (_, index) =>
      invoke(home, [
        "run",
        `Concurrent run ${index}`,
        "--provider",
        "claude",
        "--project",
        f.h.home,
        "--json",
        "--timeout",
        "60s",
      ]),
    );
    const results = await Promise.all(runs);
    for (const result of results) expect(result.code, result.stdout + result.stderr).toBe(0);
    const threads = results.map((result) => admitted.parse(JSON.parse(result.stdout)).threadId);
    expect(new Set(threads).size).toBe(20);
    for (const thread of threads) expect(f.daemon.store.getThread(thread)).toBeDefined();
  } finally {
    await f.daemon.close();
  }
}, 120_000);
