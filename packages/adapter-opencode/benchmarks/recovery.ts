import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import { createOpenCodeAdapter } from "../src/testing/v1/index.ts";
import { object } from "../src/testing/v1/data.ts";
const cli = fileURLToPath(new URL("../src/testing/cli.mjs", import.meta.url));
async function measure(count: number) {
  let origin = "";
  let authorization = "";
  let messages = 0;
  let pages = 0;
  let recovered: (() => void) | undefined;
  const adapter = createOpenCodeAdapter({
    discovery: { overrides: { opencode: cli, claude: cli, codex: cli, cursor: cli } },
    runtime: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        origin = url.origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return fetch(input, init);
      },
    },
  });
  const control = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const session = await adapter.openSession({
    threadId: ThreadId.parse("thread_benchmark"),
    cwd: "/benchmark",
    signal: new AbortController().signal,
    onExit: () => {},
    onFrame: (frame) => {
      if (
        frame.dir === "send" &&
        frame.channel === "http" &&
        String(object(frame.data).path).includes("/message?")
      )
        pages++;
      if (frame.channel === "sse" && object(object(frame.data).payload).type === "message.updated")
        messages++;
      if (frame.channel === "lifecycle" && object(frame.data).type === "resynced") recovered?.();
    },
  });
  try {
    let seed = Array.from({ length: count }, (_, i) => ({
      info: {
        id: `msg_${String(i).padStart(8, "0")}`,
        sessionID: session.nativeSessionId,
        role: "assistant",
        parentID: "user",
        time: { created: i, completed: i + 1 },
      },
      parts: [
        {
          id: `part_${i}`,
          sessionID: session.nativeSessionId,
          type: "text",
          text: `${i}:` + "x".repeat(2000),
          time: { end: i + 1 },
        },
      ],
    }));
    await control("/test/state", {
      messages: { [session.nativeSessionId]: seed },
      statuses: { [session.nativeSessionId]: { type: "idle" } },
    });
    seed = [];
    const sample = async () => {
      messages = 0;
      pages = 0;
      const ready = new Promise<void>((resolve) => {
        recovered = resolve;
      });
      const start = performance.now();
      await control("/test/drop", {});
      await ready;
      return { ms: Number((performance.now() - start).toFixed(2)), messages, pages };
    };
    return { historyMessages: count, initial: await sample(), reconnect: await sample() };
  } finally {
    await session.close("shutdown");
    await adapter.close();
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: [await measure(20_000), await measure(40_000)],
    },
    null,
    2,
  ),
);
