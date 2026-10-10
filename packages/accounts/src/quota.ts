import { z } from "zod";
import { ProviderPayloadSchema } from "@ace/provider-kit/payload";
import { AccountQuota, type QuotaWindow } from "@ace/protocol/accounts";
import { object, number, decodeWindows } from "./quota-decode.ts";
import { parseLimitReset } from "./reset-time.ts";
import { reportedBilling } from "./billing.ts";

export function initialQuota(): AccountQuota {
  return { auth: "unknown", observedAt: 0, windows: {}, blockers: {}, usage: {} };
}
export type QuotaFact = {
  provider: "codex" | "claude" | "opencode" | "cursor" | "acp" | "pi";
  /** ProviderPayload from encoded bytes. Uncertified input is blocked without traversal. */
  payload: unknown;
  observedAt: number;
  timeZone: string;
};
/** Parse only fields we own. The caller retains raw even for unknown/malformed facts. */
export function ingestQuota(
  state: AccountQuota,
  fact: QuotaFact,
): { state: AccountQuota; raw: unknown } {
  const payload = ProviderPayloadSchema.safeParse(fact.payload).data;
  if (fact.provider === "acp") return { state, raw: payload?.data };
  // Never enumerate an object whose encoded byte budget was not verified at admission.
  if (!payload)
    return {
      state: { ...state, blockers: { ...state.blockers, overflow: true } },
      raw: fact.payload,
    };
  const raw = payload.data;
  if (!Number.isFinite(fact.observedAt) || fact.observedAt < state.observedAt)
    return { state, raw };
  const frame = object(raw);
  const body = object(frame["params"] ?? frame);
  const decoded = decodeWindows(fact.provider, body);
  const billing = reportedBilling(body);
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
      resetsAt:
        parseLimitReset(error, fact.observedAt, fact.timeZone) ??
        fact.observedAt + 5 * 60 * 60 * 1000,
      source: "limit_error",
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
  if (
    !auth &&
    !billing.billingMode &&
    !billing.plan &&
    !decoded.count &&
    !decoded.overflow &&
    !Object.keys(usage).length &&
    !limited
  )
    return { state, raw };
  const windows: Record<string, QuotaWindow> =
    decoded.authoritative && decoded.complete && decoded.count ? {} : { ...state.windows };
  if (decoded.complete && decoded.count) {
    if (!limited) delete blockers.limitError;
    if (decoded.authoritative) delete blockers.overflow;
  }
  for (const [name, window] of Object.entries(windows))
    if (window.resetsAt !== null && window.resetsAt <= fact.observedAt) delete windows[name];
  let count = Object.keys(windows).length;
  for (const [name, decodedWindow] of Object.entries(decoded.windows)) {
    const window =
      decodedWindow.usedPercent >= 100 && decodedWindow.resetsAt === null
        ? { ...decodedWindow, resetsAt: fact.observedAt + 5 * 60 * 60 * 1000 }
        : decodedWindow;
    if (Object.hasOwn(windows, name)) windows[name] = window;
    else if (count < 32) {
      windows[name] = window;
      count++;
    } else blockers.overflow = true;
  }
  if (decoded.overflow) blockers.overflow = true;
  return {
    state: {
      ...state,
      ...(billing.billingMode ? { billingMode: billing.billingMode } : {}),
      ...(billing.plan
        ? { plan: billing.plan }
        : billing.billingMode === "api"
          ? { plan: undefined }
          : {}),
      auth: auth && auth !== "unknown" ? auth : state.auth,
      ...(state.cursorSdkAuth ? { cursorSdkAuth: state.cursorSdkAuth } : {}),
      observedAt: fact.observedAt,
      windows,
      blockers,
      usage: { ...state.usage, ...usage },
    },
    raw,
  };
}
