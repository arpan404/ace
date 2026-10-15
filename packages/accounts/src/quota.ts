import { z } from "zod";
import { ProviderPayloadSchema } from "@ace/provider-kit/payload";
import { AccountQuota, QuotaResetCredits, type QuotaWindow } from "@ace/protocol/accounts";
import { object, number, decodeResetCredits, decodeWindows } from "./quota-decode.ts";
import { parseLimitReset } from "./reset-time.ts";
import { reportedBilling } from "./billing.ts";

/**
 * Codex's `codexErrorInfo` codes that say the account itself is out of usage (app-server
 * `ErrorNotification` / `TurnError`). Everything else, throttles and retries included, is not.
 */
const codexLimitCodes = new Set(["usageLimitExceeded"]);
const limitMessage = z.string().max(16_384);
/** The provider's definite usage-limit error in a frame, with its words for the reset time. */
function definiteLimit(
  provider: QuotaFact["provider"],
  body: Record<string, unknown>,
): { message: string } | undefined {
  if (provider !== "codex") return undefined;
  const error = object(body["error"]);
  const code = z.string().max(128).safeParse(error["codexErrorInfo"]).data;
  if (code === undefined || !codexLimitCodes.has(code)) return undefined;
  return { message: limitMessage.safeParse(error["message"]).data ?? "" };
}
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
  // ACP frames carry no quota; only ace's own usage-source reading (`usageWindows`) does.
  if (fact.provider === "acp" && !Object.hasOwn(object(payload?.data), "usageWindows"))
    return { state, raw: payload?.data };
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
  const resetCredits =
    fact.provider === "codex"
      ? decodeResetCredits(body)
      : fact.provider === "claude"
        ? QuotaResetCredits.safeParse(body["resetCredits"]).data
        : undefined;
  const blockers = { ...state.blockers };
  // Only the provider's own usage-limit code holds the account; its words only say when it
  // resets. Free text that mentions a limit (a retried 429, an echoed message) is no signal.
  const limited = definiteLimit(fact.provider, body);
  if (limited)
    blockers.limitError = {
      usedPercent: 100,
      resetsAt: parseLimitReset(limited.message, fact.observedAt, fact.timeZone),
      source: "limit_error",
      observedAt: fact.observedAt,
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
    !limited &&
    !resetCredits
  )
    return { state, raw };
  const windows: Record<string, QuotaWindow> =
    decoded.authoritative && decoded.complete && decoded.count ? {} : { ...state.windows };
  if (decoded.complete && decoded.count) {
    if (!limited) delete blockers.limitError;
    if (decoded.authoritative) delete blockers.overflow;
  }
  // Windows past their reset stay, with when they were read: a provider reports some windows
  // only during a turn, and an old reading is shown as old rather than dropped.
  let count = Object.keys(windows).length;
  for (const [name, decodedWindow] of Object.entries(decoded.windows)) {
    const window = { ...decodedWindow, observedAt: fact.observedAt };
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
      // Sparse updates leave out banked resets; only a report that carries them replaces them.
      ...(resetCredits ? { resetCredits } : {}),
      observedAt: fact.observedAt,
      windows,
      blockers,
      usage: { ...state.usage, ...usage },
    },
    raw,
  };
}
