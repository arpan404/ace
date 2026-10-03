// Non-gating public translator workload. Do not execute before the owner merge gate.
import { createTranslator } from "../src/index.ts";
const translator = createTranslator({ rootKey: "root" });
let seq = 0;
const deliver = (data: unknown, dir: "send" | "recv" = "recv", channel = "sdk") => {
  translator.translate({ seq: seq++, t: seq, dir, channel, data }, seq);
};
deliver({
  type: "system",
  subtype: "init",
  session_id: "bench",
  capabilities: ["interrupt_receipt_v1"],
});
const operations = 100_000;
const start = performance.now();
for (let i = 0; i < operations; i++) {
  const uuid = `send-${i}`;
  deliver({ type: "user", uuid, message: { content: [] } }, "send");
  deliver({
    type: "result",
    uuid: `result-${i}`,
    result_index: i,
    user_message_uuids: [uuid],
    queued_turn_count: 0,
    usage: { input_tokens: 10, output_tokens: 3 },
    total_cost_usd: i / 100,
    modelUsage: {
      sonnet: {
        inputTokens: i * 10,
        outputTokens: i * 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: i / 100,
      },
    },
  });
}
const elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    turnsPerSecond: (operations / elapsed) * 1000,
    microsecondsPerTurn: (elapsed * 1000) / operations,
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
);
