import { z } from "zod";
import { ThreadId } from "./ids.ts";
/** Deprecated ace selectors, retained to decode historical Pi profiles. Pi has no native mode enum. */
export const PiPermissionMode = z.enum([
  "unrestricted",
  "read_only",
  "supervised",
  "auto_accept_edits",
]);
export type PiPermissionMode = z.infer<typeof PiPermissionMode>;
export const PiProfile = z.object({
  version: z.string(),
  supported: z.boolean(),
  rollbackConversation: z.boolean(),
  extensionDialogs: z.boolean(),
  mcpExtension: z.boolean(),
  permissions: z.array(PiPermissionMode),
});
export const PiControlRequest = z.object({
  type: z.literal("pi.control"),
  requestId: z.string().min(1).max(128),
  threadId: ThreadId,
  operation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("profile") }),
    z.object({ kind: z.literal("fork"), entryId: z.string().min(1).max(128).optional() }),
    z.object({ kind: z.literal("rollback"), entryId: z.string().min(1).max(128) }),
  ]),
});
export type PiControlRequest = z.infer<typeof PiControlRequest>;
export const PiControlResult = z.object({
  type: z.literal("pi.result"),
  requestId: z.string().min(1).max(128),
  result: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      nativeSessionId: z.string().optional(),
      profile: PiProfile.optional(),
    }),
    z.object({ ok: z.literal(false), error: z.string().max(1024) }),
  ]),
});
export type PiControlResult = z.infer<typeof PiControlResult>;
