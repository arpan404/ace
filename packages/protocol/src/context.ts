import { z } from "zod";
import { ThreadId } from "./ids.ts";

export const BlobHash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Mention = z.object({
  path: z.string().min(1).max(1024),
  lines: z
    .object({ start: size.positive(), end: size.positive() })
    .refine((lines) => lines.end >= lines.start)
    .meta({ "x-ace-constraint": "end >= start." })
    .optional(),
});
export type Mention = z.infer<typeof Mention>;
export const ThreadRefContextItem = z.strictObject({
  type: z.literal("thread_ref"),
  threadId: ThreadId,
  budgetBytes: z.number().int().min(1024).max(8192).default(4096),
});
export type ThreadRefContextItem = z.infer<typeof ThreadRefContextItem>;
export const ResolvedThreadReference = z.object({
  type: z.literal("thread_ref"),
  threadId: ThreadId,
  summary: z.string().max(8192),
  truncated: z.boolean(),
  pointer: z.object({ threadId: ThreadId, before: size.nullable() }),
});
export type ResolvedThreadReference = z.infer<typeof ResolvedThreadReference>;
export const MessageContext = z.object({
  items: z.array(ThreadRefContextItem).max(8).optional(),
  mentions: z.array(Mention).max(64).default([]),
  attachments: z
    .array(z.object({ sha256: BlobHash }))
    .max(64)
    .default([]),
});
export type MessageContext = z.infer<typeof MessageContext>;
export const Attachment = z.object({
  sha256: BlobHash,
  bytes: size,
  mimeType: z.string().max(128),
  name: z.string().max(255),
  width: size.positive().optional(),
  height: size.positive().optional(),
});
export type Attachment = z.infer<typeof Attachment>;
export const ContextErrorCode = z.enum([
  "invalid_request",
  "forbidden",
  "not_found",
  "outside_workspace",
  "ignored",
  "binary",
  "truncated",
  "quota",
  "busy",
  "offset",
  "hash_mismatch",
  "invalid_image",
  "unsupported",
]);
export type ContextErrorCode = z.infer<typeof ContextErrorCode>;
export const ContextDiagnostic = z.object({
  code: ContextErrorCode,
  path: z.string().optional(),
  message: z.string(),
});
export type ContextDiagnostic = z.infer<typeof ContextDiagnostic>;
export const ResolvedMention = z.object({
  path: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});
export type ResolvedMention = z.infer<typeof ResolvedMention>;
export const ContextOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upload.begin"),
    threadId: ThreadId,
    sha256: BlobHash,
    bytes: size.positive(),
    name: z.string().min(1).max(255),
  }),
  z.object({ op: z.literal("upload.status"), uploadId: key }),
  z.object({
    op: z.literal("upload.chunk"),
    uploadId: key,
    offset: size,
    data: z
      .string()
      .min(4)
      .max(87384)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.object({ op: z.literal("upload.commit"), uploadId: key }),
  z.object({ op: z.literal("upload.cancel"), uploadId: key }),
  z.object({ op: z.literal("attachment.list"), threadId: ThreadId }),
  z.object({ op: z.literal("attachment.release"), threadId: ThreadId, sha256: BlobHash }),
  z.object({
    op: z.literal("mention.resolve"),
    threadId: ThreadId,
    mentions: z.array(Mention).min(1).max(64),
  }),
  z.object({
    op: z.literal("mention.complete"),
    threadId: ThreadId,
    query: z.string().max(128),
    limit: z.number().int().min(1).max(50).default(20),
  }),
]);
export type ContextOperation = z.infer<typeof ContextOperation>;
export const ContextRequest = z.object({
  type: z.literal("context.request"),
  requestId: key,
  operation: ContextOperation,
});
export type ContextRequest = z.infer<typeof ContextRequest>;
export const ContextResult = z.object({
  type: z.literal("context.result"),
  requestId: key,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("error"), code: ContextErrorCode, message: z.string() }),
    z.object({ kind: z.literal("upload"), uploadId: key, offset: size, bytes: size }),
    z.object({ kind: z.literal("attachment"), attachment: Attachment }),
    z.object({ kind: z.literal("attachments"), attachments: z.array(Attachment).max(256) }),
    z.object({
      kind: z.literal("mentions"),
      entries: z.array(ResolvedMention),
      diagnostics: z.array(ContextDiagnostic),
    }),
    z.object({ kind: z.literal("completion"), paths: z.array(z.string()).max(50) }),
    z.object({ kind: z.literal("ok") }),
  ]),
});
export type ContextResult = z.infer<typeof ContextResult>;
