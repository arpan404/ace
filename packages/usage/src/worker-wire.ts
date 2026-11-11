import { SessionTotalsRequest, SessionTotalPage } from "./session-totals.ts";
import { z } from "zod";
import { wireShape } from "@ace/provider-kit/wire-shape";
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
const WorkerRequest = z.object({ id: seq, call: WorkerCall });
const WorkerResponse = z.discriminatedUnion("ok", [
  z.object({
    id: seq,
    ok: z.literal(true),
    value: z.union([seq, UsageResult, UsageBurn, SessionTotalPage, z.null()]),
  }),
  z.object({ id: seq, ok: z.literal(false) }),
]);
/**
 * Messages between the daemon and its usage worker. Both ends are this build (the worker
 * checks `usageWireShape` when it starts), so they are typed, not parsed on receipt: each call's
 * arguments are validated by the `UsageWorker` method that takes them, and each reply's value
 * by the method that returns it.
 */
export type WorkerRequest = z.output<typeof WorkerRequest>;
export type WorkerResponse = z.output<typeof WorkerResponse>;
export const usageWireShape = wireShape([WorkerConfig, WorkerRequest, WorkerResponse]);
