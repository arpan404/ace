import { SessionTotalsRequest, SessionTotalPage } from "./session-totals.ts";
import { z } from "zod";
import { UsageBurn, UsageQuery, UsageResult } from "@ace/protocol";
import { UsageBatch } from "./events.ts";
import { UsageSettings } from "./settings.ts";
import { QuotaWindow } from "./quotas.ts";
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkerConfig = z.object({ path: z.string().min(1), settings: UsageSettings });
export const WorkerCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("cursor") }),
  z.object({ method: z.literal("sessionTotals"), query: SessionTotalsRequest }),
  z.object({ method: z.literal("ingest"), batch: UsageBatch }),
  z.object({ method: z.literal("summary"), query: UsageQuery }),
  z.object({ method: z.literal("series"), query: UsageQuery }),
  z.object({
    method: z.literal("burn"),
    account: z.string().min(1).max(512),
    window: QuotaWindow,
    now: z.number().nonnegative(),
  }),
  z.object({ method: z.literal("close") }),
]);
export type WorkerCall = z.infer<typeof WorkerCall>;
export const WorkerRequest = z.object({ id: seq, call: WorkerCall });
export const WorkerResponse = z.discriminatedUnion("ok", [
  z.object({
    id: seq,
    ok: z.literal(true),
    value: z.union([seq, UsageResult, UsageBurn, SessionTotalPage, z.null()]),
  }),
  z.object({ id: seq, ok: z.literal(false) }),
]);
