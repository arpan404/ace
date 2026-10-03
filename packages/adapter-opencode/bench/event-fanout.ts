// Non-gating fake-server transport/fan-out benchmark. Execution reserved for merge.
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createOpenCodeAdapter } from "../src/index.ts";
import { ThreadId } from "@ace/protocol";
import { object } from "../src/data.ts";
const cli = fileURLToPath(new URL("../src/testing/cli-v2.mjs", import.meta.url));
for (const subscribers of [1, 16, 64]) {
  let url = "",
    authorization = "",
    received = 0;
  const completion = Promise.withResolvers<void>();
  const count = 10000;
  const adapter = createOpenCodeAdapter({
    runtime: {
      discover: async () => ({
        opencode: { installed: true, path: cli, version: "2.0.22", auth: "unknown", loginHint: "" },
        claude: { installed: false, auth: "unknown", loginHint: "" },
        codex: { installed: false, auth: "unknown", loginHint: "" },
        cursor: { installed: false, auth: "unknown", loginHint: "" },
      }),
      fetch: (input, init) => {
        url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        ).origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return fetch(input, init);
      },
    },
  });
  try {
    const sessions = [];
    for (let n = 0; n < subscribers; n++)
      sessions.push(
        await adapter.openSession({
          cwd: "/bench",
          threadId: ThreadId.parse(`thread_bench_${n}`),
          signal: new AbortController().signal,
          onExit: () => {},
          onFrame: (frame) => {
            if (
              frame.channel === "sse" &&
              object(frame.data).type === "session.text.delta" &&
              ++received === count
            )
              completion.resolve();
          },
        }),
      );
    const root = sessions[0]?.nativeSessionId;
    const started = performance.now();
    for (let batch = 0; batch < count; batch += 100) {
      const response = await fetch(new URL("/test/events", url), {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(
          Array.from({ length: 100 }, () => ({
            type: "session.text.delta",
            directory: "/bench",
            data: { sessionID: root, assistantMessageID: "message", ordinal: 0, delta: "text" },
          })),
        ),
      });
      await response.body?.cancel();
    }
    await completion.promise;
    const elapsedMs = performance.now() - started;
    console.log(
      JSON.stringify({
        subscribers,
        count,
        elapsedMs,
        opsPerSecond: (count * 1000) / elapsedMs,
        peakRss: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await adapter.close();
  }
}
