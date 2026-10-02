import { z } from "zod";
import type { RawPayload } from "@ace/protocol";
export type Data = Record<string, unknown>;
const ObjectData = z.record(z.string(), z.unknown());
export function object(value: unknown): Data {
  const result = ObjectData.safeParse(value);
  return result.success ? result.data : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function list(value: unknown): unknown[] {
  const parsed = z.array(z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : [];
}
export function raw(data: unknown, type: string, name?: string): RawPayload {
  return { type, data, ...(name ? { name } : {}) };
}
export function rpcId(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}
