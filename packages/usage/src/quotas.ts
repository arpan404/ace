import { z } from "zod";
import type { UsageBurn } from "@ace/protocol";
const time = z.number().int().nonnegative().max(8.64e15);
export const QuotaWindow = z
  .object({
    id: z.string().min(1).max(512),
    unit: z.enum(["tokens", "usd"]),
    start: time,
    end: time,
    remaining: z.number().nonnegative().nullable(),
  })
  .refine((w) => w.end > w.start);
export type QuotaWindow = z.infer<typeof QuotaWindow>;
export interface QuotaReader {
  windows(account: string): Promise<readonly QuotaWindow[]>;
}
export function burnRate(window: QuotaWindow, observed: number, now: number): UsageBurn {
  const elapsed = Math.max(0, Math.min(now, window.end) - window.start);
  const perHour = elapsed > 0 ? (observed / elapsed) * 3_600_000 : 0;
  const exhaustion =
    window.remaining !== null && perHour > 0 && now < window.end
      ? now + (window.remaining / perHour) * 3_600_000
      : null;
  return {
    windowId: window.id,
    unit: window.unit,
    observed,
    perHour,
    remaining: window.remaining,
    exhaustionAt: exhaustion !== null && exhaustion <= window.end ? exhaustion : null,
  };
}
