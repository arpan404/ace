import { z } from "zod";
import type { ClaudeState } from "./state.ts";
import { object, type Data } from "./native.ts";

/** Native subscription ratios and epoch seconds. No invented token limit or model entitlement. */
export const ClaudeRateLimitObservation = z
  .object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    rateLimitType: z.string().max(256).optional(),
    resetsAt: z.number().nonnegative().optional(),
    utilization: z.number().nonnegative().optional(),
    overageStatus: z.string().optional(),
    overageResetsAt: z.number().nonnegative().optional(),
  })
  .passthrough();
export type ClaudeRateLimitObservation = z.infer<typeof ClaudeRateLimitObservation>;
export function rateLimitFacts(state: ClaudeState, data: Data): void {
  const parsed = ClaudeRateLimitObservation.safeParse(object(data["rate_limit_info"]));
  if (!parsed.success) return;
  const info = parsed.data;
  const bucket = info.rateLimitType ?? "unspecified";
  if (info.status === "rejected") {
    if (state.rateBlocks.size >= 64 && !state.rateBlocks.has(bucket)) {
      state.retryOn = "upstream";
      state.emit({
        type: "retry",
        agent: state.root,
        on: "upstream",
        message: "Claude rate window capacity reached",
      });
      return;
    }
    state.rateBlocks.add(bucket);
    state.retryOn = "rate_limit";
    state.emit({
      type: "retry",
      agent: state.root,
      on: "rate_limit",
      message: "Claude rate limit",
    });
  } else {
    const wasBlocked = state.rateBlocks.delete(bucket);
    if (wasBlocked && state.rateBlocks.size === 0) {
      state.emit({ type: "limit.cleared", agent: state.root });
      if (state.retryOn === "rate_limit") state.retryOn = undefined;
    }
  }
}
