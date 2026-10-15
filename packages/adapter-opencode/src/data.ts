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
/**
 * A failed turn whose upstream provider says, in its own words, that the account is out of
 * quota or credit (OpenAI, Anthropic and OpenRouter phrasing). OpenCode reports no usage-limit
 * code, so this only names the failure for display: it stays a failed turn and never holds
 * queued messages, since prose is not a definite limit.
 */
export function failureCode(message: string): "usage_limit" | undefined {
  return /insufficient[_ ]quota|exceeded your current quota|usage limit|out of usage|credit balance is too low|insufficient credits/i.test(
    message,
  )
    ? "usage_limit"
    : undefined;
}
/** OpenCode retrying a request, throttled ones included, is a wait and never a usage limit. */
export function retryReason(message: string): "network" | "upstream" {
  return /ECONN|ENOTFOUND|network|socket|fetch failed|timed? ?out/i.test(message)
    ? "network"
    : "upstream";
}
