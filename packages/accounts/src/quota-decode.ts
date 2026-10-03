import { z } from "zod";
import type { QuotaWindow } from "@ace/protocol/accounts";
// Validate the container without cloning/enumerating an unbounded provider map.
const container = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
export function object(value: unknown): Record<string, unknown> {
  return container.safeParse(value).data ?? {};
}
export const number = z.number().finite().nonnegative();
const resetValue = z.union([number, z.string().max(128)]).nullish();
const codexLabel = z.string().min(1).max(100);
const codexWindow = z.object({ usedPercent: number, resetsAt: number.nullish() });
const claudeWindow = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  utilization: number.optional(),
  resetsAt: resetValue,
  rateLimitType: z.string().min(1).max(128).optional(),
  resets_at: resetValue,
});
export function reset(value: unknown): number | null {
  if (typeof value === "string") {
    const n = Date.parse(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const n = number.safeParse(value).data;
  return n === undefined || !Number.isFinite(n * 1000) ? null : n * 1000;
}
export function decodeWindows(provider: string, body: Record<string, unknown>) {
  const windows: Record<string, QuotaWindow> = {};
  let count = 0;
  let inspected = 0;
  let overflow = false;
  let complete = true;
  const put = (name: string, usedPercent: number, resetsAt: number | null) => {
    if (
      !name.length ||
      name.length > 128 ||
      ["__proto__", "constructor", "prototype"].includes(name)
    ) {
      complete = false;
      return;
    }
    if (!Object.hasOwn(windows, name)) {
      if (count >= 32) {
        overflow = true;
        return;
      }
      count++;
    }
    windows[name] = { usedPercent: Math.min(100, usedPercent), resetsAt };
  };
  // At most 32 entries are decoded, plus one lookahead; malformed entries consume budget too.
  const each = (value: unknown, visit: (name: string, value: unknown) => void) => {
    const map = container.safeParse(value).data;
    if (!map) {
      complete = false;
      return;
    }
    for (const name in map) {
      if (!Object.hasOwn(map, name)) continue;
      if (++inspected > 32) {
        overflow = true;
        break;
      }
      visit(name, map[name]);
      if (overflow) break;
    }
  };
  const authoritative =
    Object.hasOwn(body, "rateLimitsByLimitId") || Object.hasOwn(body, "rate_limits");
  if (provider === "codex") {
    const snapshot = (key: string, value: unknown) => {
      const row = container.safeParse(value).data;
      if (!row) {
        complete = false;
        return;
      }
      const label = row["limitId"] === undefined ? key : codexLabel.safeParse(row["limitId"]).data;
      if (label === undefined) {
        complete = false;
        return;
      }
      let present = false;
      for (const name of ["primary", "secondary"]) {
        if (row[name] == null) continue;
        present = true;
        const window = codexWindow.safeParse(row[name]).data;
        if (!window) {
          complete = false;
          continue;
        }
        put(`${label}:${name}`, window.usedPercent, reset(window.resetsAt));
      }
      if (!present) complete = false;
    };
    if (Object.hasOwn(body, "rateLimitsByLimitId")) each(body["rateLimitsByLimitId"], snapshot);
    else if (Object.hasOwn(body, "rateLimits")) snapshot("default", body["rateLimits"]);
  }
  if (provider === "claude") {
    if (Object.hasOwn(body, "rate_limit_info")) {
      const event = claudeWindow.safeParse(body["rate_limit_info"]).data;
      if (!event || (!event.status && event.utilization === undefined)) complete = false;
      else {
        const info = object(body["rate_limit_info"]);
        if (Object.hasOwn(info, "unifiedWindows"))
          each(info["unifiedWindows"], (name, value) => {
            const w = claudeWindow.safeParse(value).data;
            if (w?.utilization === undefined) {
              complete = false;
              return;
            }
            put(name, w.utilization * 100, reset(w.resetsAt));
          });
        const name = event.rateLimitType ?? "default";
        if (event.status === "rejected" || !Object.hasOwn(windows, name))
          put(
            name,
            event.status === "rejected"
              ? 100
              : event.utilization !== undefined
                ? event.utilization * 100
                : event.status === "allowed_warning"
                  ? 80
                  : 0,
            reset(event.resetsAt),
          );
      }
    }
    if (Object.hasOwn(body, "rate_limits"))
      each(body["rate_limits"], (name, value) => {
        const w = claudeWindow.safeParse(value).data;
        if (w?.utilization === undefined) {
          complete = false;
          return;
        }
        put(name, w.utilization, reset(w.resets_at ?? w.resetsAt));
      });
  }
  return { windows, count, overflow, complete: complete && !overflow, authoritative };
}
