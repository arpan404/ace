// Merge-time benchmark only. Do not execute during review under the owner's no-tests rule.
import { performance } from "node:perf_hooks";
import { createTextRedactor, createStreamingRedactor } from "@ace/redaction";

function measure(run: () => number, now: () => number, iterations: number) {
  const start = now();
  let outputCharacters = 0;
  for (let iteration = 0; iteration < iterations; iteration++) outputCharacters += run();
  return { iterations, elapsedMs: now() - start, outputCharacters };
}

const context = { env: { USER: "text", CURSOR_API_KEY: "benchmark-synthetic-secret" } };
for (const size of [4096, 65536]) {
  const tail = " benchmark-synthetic-secret";
  const prose = "x".repeat(size - tail.length) + tail;
  const cached = createTextRedactor(context);
  const streamed = createStreamingRedactor(context);
  for (const [operation, run] of [
    ["literal cached", () => cached(prose).length],
    ["literal constructed per error", () => createTextRedactor(context)(prose).length],
    [
      "streamed",
      () => {
        let length = 0;
        for (const chunk of streamed(prose)) length += chunk.length;
        return length;
      },
    ],
  ] as const)
    process.stdout.write(
      JSON.stringify({
        operation,
        inputCharacters: prose.length,
        ...measure(run, () => performance.now(), 1000),
      }) + "\n",
    );
}
const escaped = "\0".repeat(65536);
const literal = createTextRedactor(context);
process.stdout.write(
  JSON.stringify({
    operation: "escaped literal",
    inputCharacters: escaped.length,
    encodedCharacters: JSON.stringify(escaped).length,
    ...measure(
      () => literal(escaped).length,
      () => performance.now(),
      1000,
    ),
  }) + "\n",
);
