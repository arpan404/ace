import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { expect, it } from "vitest";
import { setup } from "./test-support.ts";
const n = z.number().nonnegative();
const Frame = z.object({ data: z.unknown().optional() });
async function* frames(path: string) {
  const lines = createInterface({
    input: createReadStream(new URL(`../../../${path}`, import.meta.url)),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const frame = Frame.parse(JSON.parse(line));
    if (frame.data !== undefined) yield frame.data;
  }
}
it("Codex fixture totals count cumulative samplings once despite resends", async () => {
  const h = setup();
  h.thread();
  h.agent();
  const Native = z.object({
    method: z.literal("thread/tokenUsage/updated"),
    params: z.object({
      threadId: z.string(),
      tokenUsage: z.object({
        total: z.object({
          inputTokens: n,
          outputTokens: n,
          cachedInputTokens: n,
          reasoningOutputTokens: n,
        }),
      }),
    }),
  });
  for await (const frame of frames("fixtures/codex/0.159.1/tool-read.jsonl")) {
    const result = Native.safeParse(frame);
    if (!result.success) continue;
    const u = result.data.params.tokenUsage.total;
    for (let repeat = 0; repeat < 2; repeat++)
      h.usage(u.inputTokens, "root", {
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        reasoningTokens: u.reasoningOutputTokens,
      });
  }
  expect(h.totals()).toMatchObject({
    inputTokens: 42485,
    outputTokens: 150,
    cachedInputTokens: 33280,
  });
});
it("Claude result accounting uses one run aggregate instead of repeated assistant and stream reports", async () => {
  const h = setup();
  h.thread("thread", "claude");
  h.agent("root", null, null, "claude");
  const Native = z.object({
    type: z.literal("result"),
    session_id: z.string(),
    uuid: z.string(),
    total_cost_usd: n,
    usage: z.object({
      input_tokens: n,
      output_tokens: n,
      cache_read_input_tokens: n,
      cache_creation_input_tokens: n,
      cache_creation: z.object({ ephemeral_1h_input_tokens: n }),
      output_tokens_details: z.object({ thinking_tokens: n }),
    }),
  });
  for await (const frame of frames("fixtures/claude/2.1.286/tool-read.jsonl")) {
    const result = Native.safeParse(frame);
    if (!result.success) continue;
    const u = result.data.usage;
    h.send({ type: "run.started", agent: "root", run: result.data.uuid });
    for (let repeat = 0; repeat < 2; repeat++)
      h.usage(u.input_tokens, "root", {
        outputTokens: u.output_tokens,
        cachedInputTokens: u.cache_read_input_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
        cacheWrite1hTokens: u.cache_creation.ephemeral_1h_input_tokens,
        reasoningTokens: u.output_tokens_details.thinking_tokens,
        costUsd: result.data.total_cost_usd,
      });
  }
  expect(h.totals()).toMatchObject({
    inputTokens: 33267,
    outputTokens: 266,
    cachedInputTokens: 15547,
    cacheWriteTokens: 17716,
    cacheWrite1hTokens: 17716,
    reasoningTokens: 49,
  });
  expect(h.totals().providerReportedUsd).toBeCloseTo(0.1511624);
});
it("OpenCode step ids deduplicate SSE and sync envelopes without adding assistant aggregates", async () => {
  const h = setup();
  h.thread("thread", "opencode");
  h.agent("root", null, null, "opencode");
  const Part = z.object({
    id: z.string(),
    type: z.literal("step-finish"),
    cost: n,
    tokens: z.object({ input: n, output: n, reasoning: n, cache: z.object({ read: n, write: n }) }),
  });
  const Native = z.object({
    payload: z.union([
      z
        .object({ type: z.literal("message.part.updated"), properties: z.object({ part: Part }) })
        .transform((p) => p.properties.part),
      z
        .object({
          type: z.literal("sync"),
          syncEvent: z.object({ data: z.object({ part: Part }) }),
        })
        .transform((p) => p.syncEvent.data.part),
    ]),
  });
  for await (const frame of frames("fixtures/opencode/1.18.33/tool-read.jsonl")) {
    const result = Native.safeParse(frame);
    if (!result.success) continue;
    const { tokens: u, id, cost } = result.data.payload;
    h.usage(u.input, "root", {
      outputTokens: u.output,
      cachedInputTokens: u.cache.read,
      cacheWriteTokens: u.cache.write,
      reasoningTokens: u.reasoning,
      costUsd: cost,
      counterKey: id,
    });
  }
  expect(h.totals()).toMatchObject({
    inputTokens: 31418,
    outputTokens: 115,
    cachedInputTokens: 15689,
    reasoningTokens: 35,
  });
  expect(h.totals().providerReportedUsd).toBeCloseTo(0.02660574);
});
