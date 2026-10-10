import { z } from "zod";
import { Agent, Item, Thread, ThreadId, WorkspaceId } from "@ace/protocol/entities";
import {
  HistoryListRequest,
  HistoryProvider,
  HistorySession,
  HistoryScanStats,
} from "@ace/protocol/history";
import { isAbsolute } from "node:path";

export const ProviderHome = z.object({
  id: z.string().min(1).max(256),
  provider: HistoryProvider,
  homeDir: z.string().refine(isAbsolute, "Provider home must be absolute"),
  // Only offline, checkpointed snapshots may use immutable SQLite.
  offlineSnapshot: z.boolean().default(false),
});
export type ProviderHome = z.infer<typeof ProviderHome>;
export const Options = z.object({
  indexPath: z.string().refine(isAbsolute),
  instances: z
    .array(ProviderHome)
    .max(256)
    .refine(
      (instances) => new Set(instances.map((i) => i.id)).size === instances.length,
      "Instance IDs must be unique",
    ),
});
export type HistoryOptions = z.input<typeof Options>;
export const ImportInit = z.object({
  sourceId: z.string().min(1),
  threadId: ThreadId.refine((id) => id.length <= 256),
  workspaceId: WorkspaceId.refine((id) => id.length <= 256),
  agentId: z.string().min(1).max(256),
  at: z.number().int().nonnegative(),
});
export type ImportInit = z.infer<typeof ImportInit>;
export const ScanResult = HistoryScanStats.extend({
  unsupported: z.array(z.object({ instanceId: z.string(), reason: z.string() })).max(256),
  retry: z
    .array(z.object({ instanceId: z.string(), path: z.string().refine(isAbsolute) }))
    .max(4096)
    .default([]),
});
export const Packet = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread"), thread: Thread }),
  z.object({ type: z.literal("agent"), agent: Agent }),
  z.object({ type: z.literal("item"), item: Item }),
  z.object({ type: z.literal("blob.start"), id: z.string(), bytes: z.number() }),
  z.object({
    type: z.literal("blob.chunk"),
    id: z.string(),
    bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array),
  }),
  z.object({ type: z.literal("blob.end"), id: z.string() }),
  z.object({ type: z.literal("barrier") }),
  z.object({
    type: z.literal("end"),
    messageCount: z.number().int().nonnegative(),
    countAccuracy: z.enum(["exact", "sampled"]),
  }),
]);
export type Packet = z.infer<typeof Packet>;
/** Begin creates a private staging transaction, commit alone makes the thread visible.
 * Implementations store blobs/items incrementally and paginate reads (ADR 0006). */
export interface ImportSink {
  begin(thread: Thread): Promise<void>;
  appendAgent(agent: Agent): Promise<void>;
  appendItem(item: Item): Promise<void>;
  beginBlob(id: string, bytes: number): Promise<void>;
  appendBlob(id: string, bytes: Uint8Array): Promise<void>;
  endBlob(id: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
import { ArchiveCommand, PageRequest, BlobRequest } from "./archive-contracts.ts";
export const Request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("archive.write"), command: ArchiveCommand }),
  z.object({ op: z.literal("archive.thread"), id: ThreadId }),
  z.object({ op: z.literal("archive.source"), id: z.string() }),
  z.object({ op: z.literal("archive.delete"), id: ThreadId }),
  z.object({ op: z.literal("archive.agents"), id: ThreadId }),
  z.object({ op: z.literal("archive.page"), request: PageRequest }),
  z.object({ op: z.literal("archive.blob"), request: BlobRequest }),
  z.object({
    op: z.literal("scan"),
    changes: z
      .array(
        z.object({
          instanceId: z.string(),
          paths: z.array(z.string().max(4096).refine(isAbsolute)).max(4096),
        }),
      )
      .max(256)
      .optional(),
  }),
  z.object({ op: z.literal("list"), request: HistoryListRequest }),
  z.object({ op: z.literal("get"), id: z.string() }),
  z.object({ op: z.literal("reference"), id: z.string() }),
  z.object({ op: z.literal("import"), init: ImportInit }),
  z.object({ op: z.literal("import.persist"), init: ImportInit }),
  z.object({ op: z.literal("next") }),
  z.object({ op: z.literal("return") }),
  z.object({ op: z.literal("close") }),
]);
export const Envelope = z.object({ id: z.number().int(), request: Request });
export const Reply = z.object({
  id: z.number().int(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
export const SessionOrNull = HistorySession.nullable();

export const ImportResult = z.object({
  messageCount: z.number().int().nonnegative(),
  countAccuracy: z.enum(["exact", "sampled"]),
});
