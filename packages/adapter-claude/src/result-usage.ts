import { z } from "zod";
import type { Fact } from "@ace/core";
import type { ClaudeState } from "./state.ts";
import { string, type Data } from "./native.ts";
import { tokenCounts } from "./token-counts.ts";

const counts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const modelTotals = z
  .record(
    z.string().min(1).max(512),
    z
      .object({
        inputTokens: counts,
        outputTokens: counts,
        cacheReadInputTokens: counts,
        cacheCreationInputTokens: counts,
        costUSD: z.number().nonnegative(),
        contextWindow: z.number().int().positive().optional(),
      })
      .passthrough(),
  )
  .refine((value) => Object.keys(value).length <= 64);

/** Bounded duplicate window plus the native monotonic result sequence when supplied. */
export class ResultUsage {
  private readonly seen = new Set<string>();
  private highWater = -1;
  private epoch = "initial";
  reset(data: Data): void {
    this.epoch = string(data["new_conversation_id"], string(data["uuid"], this.epoch));
    this.highWater = -1;
  }
  accept(data: Data): boolean {
    const index = data["result_index"];
    if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) {
      if (index <= this.highWater) return false;
      this.highWater = index;
    }
    const uuid = string(data["uuid"]);
    if (!uuid) return true;
    if (this.seen.has(uuid)) return false;
    if (this.seen.size >= 256) this.seen.delete(this.seen.values().next().value ?? "");
    this.seen.add(uuid);
    return true;
  }
  facts(state: ClaudeState, data: Data): Fact[] {
    // Startup failures carry zeros, not evidence that saved accounting disappeared.
    if (data["startup_failure_reason"] !== undefined) return [];
    const usage = tokenCounts(data["usage"]);
    const uuid = string(data["uuid"], state.key("result", String(state.turn)));
    const facts: Fact[] = [];
    const models = modelTotals.safeParse(data["modelUsage"]);
    const contextWindow =
      models.success && state.model ? models.data[state.model]?.contextWindow : undefined;
    if (usage)
      facts.push({
        type: "usage",
        agent: state.root,
        ...usage,
        counterMode: "incremental",
        counterKey: `claude:result:${uuid}`,
        usageScope: "agent",
        ...(state.model ? { model: state.model } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      });
    // These are inclusive snapshots, never increments assigned to the root or summed with children.
    const counterKey = `claude:${state.session}:${this.epoch}`;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let cacheWriteTokens = 0;
    if (models.success)
      for (const [model, totals] of Object.entries(models.data)) {
        const input = Math.min(
          Number.MAX_SAFE_INTEGER,
          totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens,
        );
        inputTokens = Math.min(Number.MAX_SAFE_INTEGER, inputTokens + input);
        outputTokens = Math.min(Number.MAX_SAFE_INTEGER, outputTokens + totals.outputTokens);
        cachedInputTokens = Math.min(
          Number.MAX_SAFE_INTEGER,
          cachedInputTokens + totals.cacheReadInputTokens,
        );
        cacheWriteTokens = Math.min(
          Number.MAX_SAFE_INTEGER,
          cacheWriteTokens + totals.cacheCreationInputTokens,
        );
        facts.push({
          type: "usage",
          agent: state.root,
          usageScope: "model_session",
          model,
          counterMode: "cumulative",
          counterKey,
          inputTokens: input,
          outputTokens: totals.outputTokens,
          cachedInputTokens: totals.cacheReadInputTokens,
          cacheWriteTokens: totals.cacheCreationInputTokens,
          costUsd: totals.costUSD,
        });
      }
    if (
      typeof data["total_cost_usd"] === "number" &&
      Number.isFinite(data["total_cost_usd"]) &&
      data["total_cost_usd"] >= 0
    )
      facts.push({
        type: "usage",
        agent: state.root,
        usageScope: "provider_session",
        counterMode: "cumulative",
        counterKey,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        costUsd: data["total_cost_usd"],
      });
    return facts;
  }
}
