import { z } from "zod";
import { ForgePrRef } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";
const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const name = z.string().min(1).max(256);
export const ForgePrMetadata = z.object({
  title: z.string().min(1).max(256),
  body: text,
  baseBranch: name,
  labels: z.array(name).max(100),
  assignees: z
    .array(
      z
        .string()
        .regex(/^[\w-]+$/)
        .max(100),
    )
    .max(100),
});
export type ForgePrMetadata = z.infer<typeof ForgePrMetadata>;
export const ForgeLifecycleActionName = z.enum([
  "ready",
  "draft",
  "close",
  "reopen",
  "update.merge",
  "update.rebase",
  "revert",
]);
export const ForgeLifecycleSnapshot = z.object({
  pr: ForgePrRef,
  id: name,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  headSha: sha,
  baseSha: sha,
  state: z.enum(["open", "draft", "closed", "merged"]),
  metadata: ForgePrMetadata,
  editableFields: z.array(z.enum(["title", "body", "baseBranch", "labels", "assignees"])).max(5),
  actions: z.array(ForgeLifecycleActionName).max(7),
  unsupported: z.array(ForgeLifecycleActionName).max(7),
});
export type ForgeLifecycleSnapshot = z.infer<typeof ForgeLifecycleSnapshot>;
export const ForgeLifecycleAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), changes: ForgePrMetadata.partial() }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("draft") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("reopen") }),
  z.object({ kind: z.literal("update.merge") }),
  z.object({ kind: z.literal("update.rebase") }),
  z.object({
    kind: z.literal("revert"),
    title: z.string().min(1).max(256),
    body: z.string().max(60_000),
  }),
]);
export type ForgeLifecycleAction = z.infer<typeof ForgeLifecycleAction>;
export const ForgeLifecycleReceipt = z.object({
  outcome: z.enum(["accepted", "pending", "head_changed"]),
  headSha: sha,
  revertPr: ForgePrRef.optional(),
});
export type ForgeLifecycleReceipt = z.infer<typeof ForgeLifecycleReceipt>;
export const ForgeHostedLifecycleCommand = z.object({
  type: z.literal("forge.hosted.lifecycle"),
  workspaceId: WorkspaceId,
  pr: ForgePrRef,
  operation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("apply"),
      expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
      action: ForgeLifecycleAction,
    }),
    z.object({ kind: z.literal("reconcile"), operationId: name }),
  ]),
});
export const ForgeLifecycleState = z.object({
  snapshot: ForgeLifecycleSnapshot,
  operations: z
    .array(
      z.object({
        id: name,
        kind: z.string().max(100),
        state: z.enum(["accepted", "pending", "uncertain", "head_changed"]),
        revertPr: ForgePrRef.optional(),
      }),
    )
    .max(100),
});
export type ForgeLifecycleState = z.infer<typeof ForgeLifecycleState>;
