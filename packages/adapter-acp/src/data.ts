import type { RawPayload } from "@ace/protocol";
export type Data = Record<string, unknown>;
export function object(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function raw(data: unknown, type: string, name?: string): RawPayload {
  return { type, data, ...(name ? { name } : {}) };
}
export function rpcId(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}
