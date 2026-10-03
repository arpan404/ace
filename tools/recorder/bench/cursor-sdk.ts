// Non-gating, synthetic SDK frames only. Not executed under merge-only validation.
import { createCursorAdapter } from "@ace/adapter-cursor";
import { ThreadId } from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { CursorSdkEvidence } from "../src/cursor-sdk-evidence.ts";

let id = 0;
const threadId = ThreadId.parse("sdk-evidence-bench"),
  count = 100000;
const payload = (kind: string, body: unknown) =>
  new ProviderPayload(
    JSON.stringify({
      schemaVersion: 1,
      generation: "host",
      operationId: "operation",
      segment: 0,
      kind,
      body,
    }),
  );
const delta = payload("delta", { type: "text-delta", text: "change" });
const adapter = createCursorAdapter();
const start = performance.now();
for (let batch = 0; batch < count; batch += 1000) {
  const evidence = new CursorSdkEvidence(
    threadId,
    adapter.createTranslator({ threadId, rootKey: "root" }),
    { next: () => `id-${++id}` },
  );
  for (const [seq, data] of [payload("open", {}), payload("send", { input: [] })].entries())
    evidence.accept({ seq, t: seq, dir: "recv", channel: "sdk", data: data.data, payload: data });
  for (let i = 0; i < 1000; i++)
    evidence.accept({
      seq: i + 2,
      t: i + 2,
      dir: "recv",
      channel: "sdk",
      data: delta.data,
      payload: delta,
    });
}
const elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    path: "sdk-recording-evidence-fold",
    opsPerSecond: (count * 1000) / elapsed,
    microsPerOp: (elapsed * 1000) / count,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
