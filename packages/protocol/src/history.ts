import { z } from "zod";
import { ContentPart } from "./items.ts";
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
/** Progress counts only native content reads; unchanged files are statted, never sampled. */
export const HistoryScanStats = z.object({
  files: z.number().int().nonnegative(),
  reads: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export const HistoryScanStatus = z.object({
  state: z.enum(["idle", "scanning", "ready", "failed"]),
  stats: HistoryScanStats,
  unsupported: z.array(z.object({ instanceId: z.string(), reason: z.string() })).max(256),
  error: z.string().max(8192).optional(),
});
export type HistoryScanStatus = z.infer<typeof HistoryScanStatus>;
export const HistoryScanUpdated = z.object({
  type: z.literal("history.scan.updated"),
  scan: HistoryScanStatus,
});
export const HistoryListRequest = z.object({
  type: z.literal("history.list"),
  requestId: z.string().min(1).max(256).optional(),
  cwd: z.string(),
  limit: z.number().int().min(1).max(200).default(50),
  before: z.object({ lastActivity: Timestamp, id: z.string() }).optional(),
});
export const HistoryListResponse = z.object({
  type: z.literal("history.list"),
  requestId: z.string().min(1).max(256).optional(),
  scan: HistoryScanStatus.optional(),
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

export const HistoryScanRequest = z.object({
  type: z.literal("history.scan"),
  requestId: z.string().min(1).max(256).optional(),
  action: z.enum(["start", "status"]).optional(),
});
export const HistoryScanResponse = z.object({
  type: z.literal("history.scan"),
  requestId: z.string().min(1).max(256).optional(),
  scan: HistoryScanStatus.optional(),
  files: z.number().int().nonnegative(),
  unsupported: z.array(z.object({ instanceId: z.string(), reason: z.string() })).max(256),
});
export const HistoryContinueRequest = z.object({
  type: z.literal("history.continue"),
  threadId: ThreadId,
  mode: z.enum(["resume", "fork"]),
  input: z.array(ContentPart).max(64),
  delivery: z.enum(["steer", "queue"]).default("queue"),
});
export const HistoryContinueResponse = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("history.continue"),
    status: z.literal("continued"),
    threadId: ThreadId,
    instanceId: z.string(),
    nativeSessionId: z.string(),
  }),
  z.object({
    type: z.literal("history.continue"),
    status: z.literal("unsupported"),
    reason: z.string(),
  }),
]);
