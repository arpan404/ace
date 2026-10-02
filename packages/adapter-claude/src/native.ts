import { z } from "zod";
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
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
export function raw(data: unknown, name?: string): RawPayload {
  const d = object(data);
  return {
    type: string(d["type"], string(d["subtype"], "claude")),
    ...(name ? { name } : {}),
    data,
  };
}
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  return list(value)
    .map((b) => string(object(b)["text"]))
    .join("\n");
}
