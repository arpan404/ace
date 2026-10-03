import { z } from "zod";
import { sanitize } from "./redaction.ts";
import type { RawPayload } from "@ace/protocol";
export type Data = Record<string, unknown>;
const DataSchema = z.record(z.string(), z.unknown());
export function object(value: unknown): Data {
  const parsed = DataSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
export function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function raw(type: string, data: unknown, name?: string): RawPayload[] {
  const evidence = sanitize(data);
  return [{ type, data: evidence, ...(name === undefined ? {} : { name }) }];
}
export function retryReason(message: string): "rate_limit" | "network" | "upstream" {
  return /429|rate.?limit|too many requests|quota/i.test(message)
    ? "rate_limit"
    : /ECONN|ENOTFOUND|network|socket|fetch failed|timed? ?out/i.test(message)
      ? "network"
      : "upstream";
}
