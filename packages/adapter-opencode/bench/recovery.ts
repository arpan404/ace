// Fake executable only. No provider prompts. Execution is reserved for merge.
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import { createOpenCodeAdapter } from "../src/index.ts";
import { object } from "../src/data.ts";
const cli = fileURLToPath(new URL("../src/testing/cli-v2.mjs", import.meta.url));
for (const count of [1000, 10000, 50000]) {
  let origin = "",
    authorization = "",
    pages = 0;
  let accept: (() => void) | undefined;
  const adapter = createOpenCodeAdapter({
    runtime: {
      discover: async () => ({
        opencode: { installed: true, path: cli, version: "2.0.22", auth: "unknown", loginHint: "" },
        claude: { installed: false, auth: "unknown", loginHint: "" },
        codex: { installed: false, auth: "unknown", loginHint: "" },
        cursor: { installed: false, auth: "unknown", loginHint: "" },
      }),
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        origin = url.origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (url.pathname.endsWith("/message")) pages++;
        return fetch(input, init);
      },
    },
  });
  const control = async (path: string, body: unknown) => {
    const res = await fetch(new URL(path, origin), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  try {
    const session = await adapter.openSession({
      cwd: "/bench",
      threadId: ThreadId.parse("thread_benchmark"),
      signal: new AbortController().signal,
      onExit: () => {},
      onFrame: (frame) => {
        if (frame.channel === "lifecycle" && object(frame.data).type === "resynced") accept?.();
      },
    });
    const records = Array.from({ length: count }, (_, n) => ({
      id: `m-${n}`,
      type: "assistant",
      time: { completed: 1 },
      content: [{ type: "text", text: "text" }],
    }));
    await control("/test/state", { messages: { [session.nativeSessionId]: records } });
    async function recover() {
      const done = new Promise<void>((resolve) => {
        accept = resolve;
      });
      await control("/test/drop", {});
      await done;
    }
    let started = performance.now();
    await recover();
    const initialMs = performance.now() - started,
      initialPages = pages;
    await control("/test/state", {
      messages: {
        [session.nativeSessionId]: records.concat({
          id: `m-${count}`,
          type: "assistant",
          time: { completed: 2 },
          content: [{ type: "text", text: "change" }],
        }),
      },
    });
    pages = 0;
    started = performance.now();
    await recover();
    console.log(
      JSON.stringify({
        count,
        initialMs,
        initialPages,
        changedMs: performance.now() - started,
        changedPages: pages,
        peakRss: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await adapter.close();
  }
}
