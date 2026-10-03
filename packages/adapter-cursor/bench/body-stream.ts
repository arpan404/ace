// Non-gating production boundary benchmark. Do not execute before merge under owner policy.
import { streamSdkBody } from "../src/index.ts";
const count = 100,
  output = "line\n".repeat(209716);
const start = performance.now();
let chunks = 0,
  bytes = 0;
for (let i = 0; i < count; i++)
  await streamSdkBody(
    {
      type: "tool-call-completed",
      callId: `call-${i}`,
      toolCall: {
        type: "shell",
        result: { status: "success", value: { exitCode: 0, stdout: output } },
      },
    },
    `bench:${i}`,
    async (_kind, body) => {
      chunks++;
      bytes += Buffer.byteLength(JSON.stringify(body));
    },
    {},
  );
console.log(
  JSON.stringify({
    path: "sdk-body-stream-redacted-json-and-output",
    opsPerSecond: (count * 1000) / (performance.now() - start),
    microsPerOp: ((performance.now() - start) * 1000) / count,
    chunks,
    bytes,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
