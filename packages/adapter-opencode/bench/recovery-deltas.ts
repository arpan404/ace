// Public fake-server recovery benchmark. Execution reserved for merge.
import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { object } from "../src/data.ts";
import { boundary } from "./fake-boundary.ts";
for (const count of [128, 1024, 4096]) {
  const buffered = Promise.withResolvers<void>(),
    recovered = Promise.withResolvers<void>();
  let seen = 0;
  const b = boundary((frame) => {
    if (
      frame.channel === "recovery.buffered" &&
      object(frame.data).type === "session.text.delta" &&
      ++seen === count
    )
      buffered.resolve();
    if (frame.channel === "lifecycle" && object(frame.data).type === "resynced")
      recovered.resolve();
  });
  try {
    const session = await b.adapter.openSession({
      cwd: "/bench",
      threadId: ThreadId.parse("thread_recovery_deltas"),
      signal: new AbortController().signal,
      onFrame: b.observe,
      onExit: () => {},
    });
    const root = session.nativeSessionId;
    await b.control("/test/state", {
      fault: { holdHistory: true },
      beforeRead: Array.from({ length: count }, () => ({
        type: "session.text.delta",
        directory: "/bench",
        data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: "x" },
      })),
      messages: {
        [root]: [
          { id: "a", type: "assistant", content: [{ type: "text", text: "x".repeat(count) }] },
        ],
      },
    });
    const start = performance.now();
    await b.control("/test/drop", {});
    await buffered.promise;
    await b.control("/test/release", {});
    await recovered.promise;
    const elapsedMs = performance.now() - start;
    console.log(
      JSON.stringify({
        count,
        elapsedMs,
        opsPerSecond: (count * 1000) / elapsedMs,
        peakRss: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await b.adapter.close();
  }
}
