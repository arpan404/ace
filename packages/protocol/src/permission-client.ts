import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { PermissionCapabilities } from "./permissions.ts";

/** Preview the selected provider's guarantees without opening a provider session. */
export const PermissionCapabilitiesRequest = z.object({
  type: z.literal("permissions.capabilities"),
  requestId: z.string().min(1).max(128),
  provider: ProviderKind,
  backend: z.enum(["acp", "cursor-sdk"]).optional(),
});
export const PermissionCapabilitiesResult = z.object({
  type: z.literal("permissions.capabilities.result"),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  permissions: PermissionCapabilities.optional(),
  error: z.string().max(256).optional(),
});
