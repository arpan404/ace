import { z } from "zod";
import { AccountQuota, type QuotaWindow } from "@ace/protocol/accounts";
import { parseLimitReset } from "./reset-time.ts";

export function initialQuota(): AccountQuota {
  return { auth: "unknown", observedAt: 0, windows: {}, usage: {} };
}
const record = z.record(z.string(), z.unknown());
const number = z.number().finite().nonnegative();
const rateWindow = z.object({ usedPercent: number, resetsAt: number.nullish() }).passthrough();
const claudeRate = z
  .object({
    status: z.string().optional(),
    utilization: number.optional(),
    resetsAt: z.union([number, z.string()]).nullish(),
    rateLimitType: z.string().max(128).optional(),
  })
  .passthrough();
function object(value: unknown): Record<string, unknown> {
  return record.safeParse(value).data ?? {};
}
function reset(value: unknown): number | null {
  if (typeof value === "string") {
    const n = Date.parse(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const n = number.safeParse(value).data;
  return n === undefined || !Number.isFinite(n * 1000) ? null : n * 1000;
}
export function availability(
  state: AccountQuota,
  now: number,
): "available" | "near_limit" | "exhausted" | "logged_out" | "unknown" {
  if (state.auth === "logged_out") return "logged_out";
  if (state.auth !== "logged_in") return "unknown";
  let near = false;
  for (const window of Object.values(state.windows)) {
    if (window.resetsAt !== null && window.resetsAt <= now) continue;
    if (window.usedPercent >= 100) return "exhausted";
    if (window.usedPercent >= 80) near = true;
  }
  return near ? "near_limit" : "available";
}
export type QuotaFact = {
  provider: "codex" | "claude" | "opencode" | "cursor";
  payload: unknown;
  observedAt: number;
  timeZone: string;
};
/** Parse only fields we own. The caller retains raw even for unknown/malformed facts. */
export function ingestQuota(
  state: AccountQuota,
  fact: QuotaFact,
): { state: AccountQuota; raw: unknown } {
  if (!Number.isFinite(fact.observedAt) || fact.observedAt < state.observedAt)
    return { state, raw: fact.payload };
  const frame = object(fact.payload);
  const body = object(frame["params"] ?? frame);
  const changed: Record<string, QuotaWindow> = {};
  let overflow = false;
  const put = (name: string, usedPercent: number, resetsAt: number | null) => {
    if (name.length <= 128 && !["__proto__", "constructor", "prototype"].includes(name)) {
      if (name in changed || Object.keys(changed).length < 32)
        changed[name] = { usedPercent: Math.min(100, usedPercent), resetsAt };
      else overflow = true;
    }
  };
  if (fact.provider === "codex") {
    const snapshots = body["rateLimitsByLimitId"]
      ? object(body["rateLimitsByLimitId"])
      : { default: body["rateLimits"] };
    for (const [limit, value] of Object.entries(snapshots)) {
      const snapshot = object(value);
      for (const name of ["primary", "secondary"]) {
        const window = rateWindow.safeParse(snapshot[name]).data;
        if (window)
          put(
            `${z.string().max(100).safeParse(snapshot["limitId"]).data ?? limit}:${name}`,
            window.usedPercent,
            reset(window.resetsAt),
          );
      }
    }
  }
  if (fact.provider === "claude") {
    const event = claudeRate.safeParse(body["rate_limit_info"]).data;
    if (event) {
      const used =
        event.status === "rejected"
          ? 100
          : event.utilization === undefined
            ? event.status === "allowed_warning"
              ? 80
              : 0
            : event.utilization * 100;
      const unified = object(object(body["rate_limit_info"])["unifiedWindows"]);
      for (const [name, value] of Object.entries(unified)) {
        const window = claudeRate.safeParse(value).data;
        if (window?.utilization !== undefined)
          put(name, window.utilization * 100, reset(window.resetsAt));
      }
      const name = event.rateLimitType ?? "default";
      if (event.status === "rejected" || !(name in changed)) put(name, used, reset(event.resetsAt));
    }
    for (const [name, value] of Object.entries(object(body["rate_limits"]))) {
      const window = claudeRate.safeParse(value).data;
      if (window?.utilization !== undefined)
        put(name, window.utilization, reset(object(value)["resets_at"] ?? window.resetsAt));
    }
  }
  const errorBody = object(body["error"]);
  const error = z
    .string()
    .max(16_384)
    .safeParse(errorBody["message"] ?? body["error"] ?? body["message"]).data;
  if (
    error &&
    /usage limit|rate limit|limit reached|out of.*(?:usage|credits)|hit your limit/i.test(error)
  )
    put("limit_error", 100, parseLimitReset(error, fact.observedAt, fact.timeZone));
  const auth = z.enum(["logged_in", "logged_out", "unknown"]).safeParse(body["auth"]).data;
  const usageBody = object(object(body["tokenUsage"])["total"] ?? body["usage"] ?? body["session"]);
  const usage: AccountQuota["usage"] = {};
  const input = number.safeParse(usageBody["input_tokens"] ?? usageBody["inputTokens"]).data;
  const output = number.safeParse(usageBody["output_tokens"] ?? usageBody["outputTokens"]).data;
  const cost = number.safeParse(
    body["total_cost_usd"] ??
      object(body["session"])["total_cost_usd"] ??
      usageBody["total_cost_usd"] ??
      usageBody["costUsd"],
  ).data;
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cost !== undefined) usage.costUsd = cost;
  if (!auth && !Object.keys(changed).length && !Object.keys(usage).length)
    return { state, raw: fact.payload };
  const authoritative = Boolean(body["rateLimitsByLimitId"] || body["rate_limits"]);
  const windows: Record<string, QuotaWindow> =
    authoritative && Object.keys(changed).length && !overflow ? {} : { ...state.windows };
  // A fresh provider snapshot replaces a textual fallback; auth/usage alone do not.
  if (Object.keys(changed).some((name) => name !== "limit_error")) delete windows["limit_error"];
  for (const [name, window] of Object.entries(windows))
    if (window.resetsAt !== null && window.resetsAt <= fact.observedAt) delete windows[name];
  for (const [name, window] of Object.entries(changed)) {
    if (name in windows || Object.keys(windows).length < 32) windows[name] = window;
    else overflow = true;
  }
  if (overflow) {
    const victim = Object.keys(windows)[0];
    if (!("quota_overflow" in windows) && Object.keys(windows).length >= 32 && victim)
      delete windows[victim];
    windows["quota_overflow"] = { usedPercent: 100, resetsAt: null };
  }
  return {
    state: {
      auth: auth ?? state.auth,
      observedAt: fact.observedAt,
      windows,
      usage: { ...state.usage, ...usage },
    },
    raw: fact.payload,
  };
}
