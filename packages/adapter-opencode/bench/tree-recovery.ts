// Non-gating tree scaling benchmark. Not executed: tests/benchmarks run at merge.
import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { object } from "../src/data.ts";
import { boundary } from "./fake-boundary.ts";
for (const count of [1, 16, 128, 1024]) {
  let recovered = Promise.withResolvers<void>();
  const b = boundary((frame) => {
    if (frame.channel === "lifecycle" && object(frame.data).type === "resynced")
      recovered.resolve();
  });
  try {
    const session = await b.adapter.openSession({
      cwd: "/bench",
      threadId: ThreadId.parse("thread_tree"),
      signal: new AbortController().signal,
      onFrame: b.observe,
      onExit: () => {},
    });
    const ids = [
      session.nativeSessionId,
      ...Array.from({ length: count - 1 }, (_, i) => `child-${i + 1}`),
    ];
    const sessions = ids.slice(1).map((id, i) => ({
      id,
      parentID: ids[Math.floor(i / 8)],
      projectID: "project-one",
      location: { directory: "/bench" },
      time: { idle: 1 },
    }));
    await b.control("/test/state", { sessions });
    const start = performance.now();
    await b.control("/test/drop", {});
    await recovered.promise;
    const initialMs = performance.now() - start,
      initialPages = b.pages();
    recovered = Promise.withResolvers<void>();
    const changed = performance.now();
    await b.control("/test/drop", {});
    await recovered.promise;
    console.log(
      JSON.stringify({
        count,
        initialMs,
        initialPages,
        changedMs: performance.now() - changed,
        changedPages: b.pages() - initialPages,
        peakRss: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await b.adapter.close();
  }
}
