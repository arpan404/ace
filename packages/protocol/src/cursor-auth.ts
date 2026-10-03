import { z } from "zod";
import { AccountId, CursorSdkAuth } from "./accounts.ts";

const requestId = z.string().min(1).max(128);
export const CursorAuthRequest = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cursor.auth.start"),
    requestId,
    instanceId: AccountId,
    label: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({ type: z.literal("cursor.auth.poll"), requestId, loginId: requestId }),
  z.strictObject({ type: z.literal("cursor.auth.cancel"), requestId, loginId: requestId }),
  z.strictObject({ type: z.literal("cursor.auth.status"), requestId, instanceId: AccountId }),
  z.strictObject({ type: z.literal("cursor.auth.select"), requestId, instanceId: AccountId }),
  z.strictObject({ type: z.literal("cursor.auth.logout"), requestId, instanceId: AccountId }),
]);
export type CursorAuthRequest = z.infer<typeof CursorAuthRequest>;

/** Ephemeral authorized transport only: never put login challenges in ace event history. */
export const CursorAuthEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cursor.auth.login"),
    requestId,
    loginId: requestId,
    instanceId: AccountId,
    state: z.enum(["starting", "browser", "complete", "failed", "cancelled"]),
    expiresAt: z.number().finite().nonnegative(),
    // Abort on decorated input before URL normalization can conflict with the raw challenge.
    url: z
      .intersection(z.url().max(8192), z.string().regex(/^(?!.*\s)https:\/\/\S+$/, { abort: true }))
      .optional(),
    auth: CursorSdkAuth.optional(),
    error: z.enum(["login_failed", "expired", "cancelled"]).optional(),
  }),
  z.strictObject({
    type: z.literal("cursor.auth.changed"),
    requestId,
    instanceId: AccountId,
    selectedInstanceId: AccountId.nullable(),
    auth: CursorSdkAuth,
  }),
  z.strictObject({
    type: z.literal("cursor.auth.error"),
    requestId,
    code: z.enum(["unavailable", "busy", "not_found", "forbidden", "auth_failed"]),
    // Safe categories only; provider diagnostics may contain credentials or private paths.
    reason: z.enum(["service_unavailable", "instance_unavailable", "sdk_unavailable"]).optional(),
  }),
]);
export type CursorAuthEvent = z.infer<typeof CursorAuthEvent>;
