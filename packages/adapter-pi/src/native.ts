import { z } from "zod";
import { nativeRecord, type NativeRecord } from "@ace/provider-kit/record";
export const ObjectValue = z.record(z.string(), z.unknown());
export function obj(value: unknown): NativeRecord {
  return nativeRecord(value);
}
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
export const Envelope = z.looseObject({ type: z.string() });
export const Response = z.looseObject({
  type: z.literal("response"),
  id: z.string(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export const State = z.looseObject({
  sessionFile: z.string().min(1),
  sessionId: z.string().min(1),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
});
export const Dialog = z.looseObject({
  type: z.literal("extension_ui_request"),
  id: z.string().min(1),
  method: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string().default("Pi extension"),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
  timeout: z.number().nonnegative().optional(),
  prefill: z.string().optional(),
});
export type Dialog = z.infer<typeof Dialog>;
export function isBlockingDialogMethod(value: unknown): boolean {
  return Dialog.shape.method.safeParse(value).success;
}
export const Cancelled = z.looseObject({ cancelled: z.boolean() });
