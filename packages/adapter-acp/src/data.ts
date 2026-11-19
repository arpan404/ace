import type { RawPayload } from "@ace/protocol";
import { nativeRecord, type NativeRecord } from "@ace/provider-kit/record";
export type Data = Record<string, unknown>;
export type InlineRawPayload = Extract<RawPayload, { data: unknown }>;
export function object(value: unknown): NativeRecord {
  return nativeRecord(value);
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
export function raw(data: unknown, type: string, name?: string): InlineRawPayload {
  return { type, data, ...(name ? { name } : {}) };
}
export function rpcId(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}
