import { z } from "zod";
import { Attachment, BlobHash } from "./context.ts";
import { HostId, ThreadId } from "./ids.ts";
export const RemoteContextSelection = z.strictObject({
  attachments: z.array(BlobHash).max(8).default([]),
  files: z.array(z.string().min(1).max(1024)).max(8).default([]),
  threadBudgetBytes: z.number().int().min(1024).max(8192).default(4096),
});
export const RemoteContextManifest = z.strictObject({
  sourceHostId: HostId,
  sourceThreadId: ThreadId,
  summary: z.string().max(8192),
  before: z.number().int().nonnegative().nullable(),
  attachments: z.array(Attachment.extend({ sourcePath: z.string().max(1024).optional() })).max(16),
});
export type RemoteContextManifest = z.infer<typeof RemoteContextManifest>;
export const RemoteContextOperation = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("read"),
    sha256: BlobHash,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ op: z.literal("prepare") }),
  z.strictObject({ op: z.literal("begin"), sha256: BlobHash }),
  z.strictObject({
    op: z.literal("chunk"),
    uploadId: z.string().min(1).max(128),
    offset: z.number().int().nonnegative(),
    data: z.string().min(4).max(87384),
  }),
  z.strictObject({ op: z.literal("commit"), uploadId: z.string().min(1).max(128) }),
]);
export const RemoteRelayTarget = z.strictObject({
  url: z.string().url().max(4096),
  pinnedFingerprint: z.string().regex(/^[A-Z2-7]{52}$/),
});
