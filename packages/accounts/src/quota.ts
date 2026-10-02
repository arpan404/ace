import { z } from "zod";
import { AccountQuota, type QuotaWindow } from "@ace/protocol/accounts";
import { object, number, decodeWindows } from "./quota-decode.ts";
import { parseLimitReset } from "./reset-time.ts";

export function initialQuota(): AccountQuota {
  return { auth: "unknown", observedAt: 0, windows: {}, blockers: {}, usage: {} };
}
export function availability(
  state: AccountQuota,
  now: number,
): "available" | "near_limit" | "exhausted" | "logged_out" | "unknown" {
  if (state.auth === "logged_out") return "logged_out";
  if (state.auth !== "logged_in") return "unknown";
  if (state.blockers.overflow) return "exhausted";
  const fallback = state.blockers.limitError;
  if (fallback && (fallback.resetsAt === null || fallback.resetsAt > now)) return "exhausted";
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
  const decoded = decodeWindows(fact.provider, body);
  const blockers = { ...state.blockers };
  const errorBody = object(body["error"]);
  const error = z
    .string()
    .max(16_384)
    .safeParse(errorBody["message"] ?? body["error"] ?? body["message"]).data;
  const limited = Boolean(
    error &&
    /usage limit|rate limit|limit reached|out of.*(?:usage|credits)|hit your limit/i.test(error),
  );
  if (
    error &&
    /usage limit|rate limit|limit reached|out of.*(?:usage|credits)|hit your limit/i.test(error)
  )
    blockers.limitError = {
      usedPercent: 100,
      resetsAt: parseLimitReset(error, fact.observedAt, fact.timeZone),
    };
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
  if (!auth && !decoded.count && !decoded.overflow && !Object.keys(usage).length && !limited)
    return { state, raw: fact.payload };
  const windows: Record<string, QuotaWindow> =
    decoded.authoritative && decoded.complete && decoded.count ? {} : { ...state.windows };
  if (decoded.complete && decoded.count) {
    if (!limited) delete blockers.limitError;
    if (decoded.authoritative) delete blockers.overflow;
  }
  for (const [name, window] of Object.entries(windows))
    if (window.resetsAt !== null && window.resetsAt <= fact.observedAt) delete windows[name];
  let count = Object.keys(windows).length;
  for (const [name, window] of Object.entries(decoded.windows)) {
    if (Object.hasOwn(windows, name)) windows[name] = window;
    else if (count < 32) {
      windows[name] = window;
      count++;
    } else blockers.overflow = true;
  }
  if (decoded.overflow) blockers.overflow = true;
  return {
    state: {
      auth: auth ?? state.auth,
      observedAt: fact.observedAt,
      windows,
      blockers,
      usage: { ...state.usage, ...usage },
    },
    raw: fact.payload,
  };
}
