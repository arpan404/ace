import { z } from "zod";
import { StorageItem, StorageReason } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { StorageCandidate } from "./planner.ts";

export type StorageOwner = Pick<ServiceContext, "store" | "services" | "now" | "id"> & {
  root: string;
  cleanupPlanId?: string;
  afterRemove?(id: string): Promise<void>;
  /** Runs after each durable compaction step, before the next one starts. */
  afterCompactionStep?(): Promise<void>;
};
export const StorageTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread"), threadId: z.string() }),
  z.object({ type: z.literal("attachment"), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal("file"), path: z.string().max(4096) }),
  z.object({ type: z.literal("skill_root"), name: z.string().regex(/^session-[A-Za-z0-9]{6}$/) }),
  z.object({
    type: z.literal("worktree"),
    repo: z.string().max(4096),
    path: z.string().max(4096),
    gitFingerprint: z.string(),
    head: z.string().nullable(),
    branch: z.string().nullable(),
  }),
]);
export type StorageTarget = z.infer<typeof StorageTarget>;
export interface OwnedStorageCandidate extends StorageCandidate {
  target: StorageTarget;
}
export const ReviewedStorageItem = z.object({
  item: StorageItem,
  fingerprint: z.string(),
  target: StorageTarget,
  state: z.enum(["pending", "running", "removed", "protected"]).default("pending"),
  reason: StorageReason.optional(),
  error: z.string().max(128).optional(),
});
export type ReviewedStorageItem = z.infer<typeof ReviewedStorageItem>;
