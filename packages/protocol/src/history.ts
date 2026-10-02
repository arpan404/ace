import { z } from "zod";
import { NativeRef } from "./provider.ts";
import { ThreadId, WorkspaceId, Timestamp } from "./ids.ts";

export const HistoryProvider = z.enum(["claude", "codex", "opencode", "cursor"]);
export type HistoryProvider = z.infer<typeof HistoryProvider>;
export const ImportedProvenance = z.object({
  sourceId: z.string().min(1),
  instanceId: z.string().min(1),
  native: NativeRef,
  importedAt: Timestamp,
});
export type ImportedProvenance = z.infer<typeof ImportedProvenance>;
export const HistorySession = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  provider: HistoryProvider,
  nativeId: z.string().min(1),
  cwd: z.string(),
  title: z.string(),
  model: z.string().optional(),
  lastActivity: Timestamp,
  messageCount: z.number().int().nonnegative(),
  countAccuracy: z.enum(["exact", "sampled"]),
  parentNativeId: z.string().optional(),
  support: z.discriminatedUnion("status", [
    z.object({ status: z.literal("supported") }),
    z.object({ status: z.literal("unsupported"), reason: z.string() }),
  ]),
});
export type HistorySession = z.infer<typeof HistorySession>;
export const HistoryListRequest = z.object({
  type: z.literal("history.list"),
  cwd: z.string(),
  limit: z.number().int().min(1).max(200).default(50),
  before: z.object({ lastActivity: Timestamp, id: z.string() }).optional(),
});
export const HistoryListResponse = z.object({
  type: z.literal("history.list"),
  sessions: z.array(HistorySession).max(200),
  next: z.object({ lastActivity: Timestamp, id: z.string() }).nullable(),
});
export const HistoryImportRequest = z.object({
  type: z.literal("history.import"),
  sourceId: z.string().min(1),
  workspaceId: WorkspaceId,
});
export const HistoryImportResponse = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("history.import"),
    status: z.literal("imported"),
    threadId: ThreadId,
  }),
  z.object({
    type: z.literal("history.import"),
    status: z.literal("unsupported"),
    reason: z.string(),
  }),
]);
