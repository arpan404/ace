import { z } from "zod";
import { join, basename, dirname } from "node:path";

// Shared with accounts migration planning (ADR 0018). Keep unknown fields.
export const NativeSessionId = z
  .string()
  .regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i);
export const CodexSessionMeta = z
  .object({
    type: z.literal("session_meta"),
    payload: z
      .object({
        id: NativeSessionId,
        session_id: NativeSessionId.optional(),
        forked_from_id: NativeSessionId.nullish(),
        parent_thread_id: NativeSessionId.nullish(),
        cwd: z.string().optional(),
        history_mode: z.string().optional(),
        history_base: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export function codexParents(meta: z.infer<typeof CodexSessionMeta>["payload"]): string[] {
  return [
    ...new Set(
      [
        meta.forked_from_id,
        meta.parent_thread_id,
        meta.session_id === meta.id ? undefined : meta.session_id,
      ].filter((id): id is string => typeof id === "string"),
    ),
  ];
}
export function claudeSidechainRoot(transcript: string): string {
  if (!transcript.endsWith(".jsonl")) throw new Error("Expected Claude JSONL transcript");
  return join(transcript.slice(0, -6), "subagents");
}
export const RecordObject = z.record(z.string(), z.unknown());
export function object(value: unknown): Record<string, unknown> {
  return RecordObject.safeParse(value).data ?? {};
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

export function claudeSidechainParent(path: string): string | undefined {
  return basename(dirname(path)) === "subagents" ? basename(dirname(dirname(path))) : undefined;
}
