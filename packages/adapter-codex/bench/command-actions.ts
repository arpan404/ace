// Merge-only performance measurement. Not executed during development.
import { createCodexTranslator } from "../src/index.ts";
import { ThreadId } from "@ace/protocol";
for (const commandBytes of [128, 8192])
  for (const actions of [100, 1000, 10000]) {
    const command = `/bin/sh -c 'echo ${"x".repeat(commandBytes)}'`;
    const item = {
      type: "commandExecution",
      id: "command",
      command,
      commandActions: Array.from({ length: actions }, (_, i) => ({
        type: "read",
        path: `file-${i}`,
      })),
    };
    const samples: number[] = [];
    for (let sample = 0; sample < 10; sample++) {
      const translator = createCodexTranslator({
        threadId: ThreadId.parse("bench"),
        rootKey: "root",
      });
      translator.translate(
        {
          seq: 0,
          t: 0,
          dir: "recv",
          channel: "stdio",
          data: { method: "thread/started", params: { thread: { id: "native" } } },
        },
        0,
      );
      const start = performance.now();
      translator.translate(
        {
          seq: 1,
          t: 1,
          dir: "recv",
          channel: "stdio",
          data: { method: "item/completed", params: { threadId: "native", turnId: "turn", item } },
        },
        1,
      );
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ commandBytes, actions, medianMs: samples[5], maxMs: samples[9] }));
  }
