import { z } from "zod";
import { ProviderKind } from "./provider.ts";

/** Local runtime discovery is independent of ace's account registry and adapter capabilities. */
export const ProviderStatus = z.object({
  provider: ProviderKind,
  readiness: z
    .enum([
      "not_installed",
      "installed_signed_out",
      "signed_in",
      "needs_attention",
      "not_configured",
    ])
    .optional(),
  installHint: z.string().max(1024).optional(),
  installCommand: z.string().max(256).optional(),
  updateAvailable: z.boolean().optional(),
  runtime: z.enum(["cli", "cursor-sdk"]),
  installed: z.boolean().nullable(),
  enabled: z.boolean().optional(),
  path: z.string().min(1).max(4096).optional(),
  version: z.string().min(1).max(256).optional(),
  auth: z.enum(["logged_in", "logged_out", "unknown"]),
  accountLabel: z.string().min(1).max(256).optional(),
  authDetail: z.string().max(1024).optional(),
  authEvidence: z.literal("credentials_configured").optional(),
  loginHint: z.string().max(1024),
  error: z.string().max(1024).optional(),
  checkedAt: z.number().nonnegative().optional(),
  stale: z.boolean(),
  refreshing: z.boolean(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;
export const ProvidersRequest = z.object({
  type: z.literal("providers.request"),
  requestId: z.string().min(1).max(128),
  operation: z.enum(["list", "refresh", "readiness"]).default("list"),
});
export const ProvidersResult = z.object({
  type: z.literal("providers.result"),
  requestId: z.string().min(1).max(128),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), providers: z.array(ProviderStatus).max(16) }),
    z.object({ ok: z.literal(false), error: z.enum(["forbidden", "unavailable", "busy"]) }),
  ]),
});

export type ProvidersResult = z.infer<typeof ProvidersResult>;
