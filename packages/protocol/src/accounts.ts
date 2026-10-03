import { z } from "zod";

export const AccountProvider = z.enum(["codex", "claude", "opencode", "cursor"]);
export const AccountId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const AccountAssignment = z.object({
  instanceId: AccountId.optional(),
  role: z.string().min(1).max(64),
  estimatedLoad: z.number().finite().min(0).max(100),
});
export type AccountAssignment = z.infer<typeof AccountAssignment>;
export const AccountDirectory = z
  .string()
  .max(4096)
  .refine((s) => s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s));
export const AccountEnvKey = z.enum([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CURSOR_DATA_DIR",
]);
export const ProviderInstance = z.object({
  id: AccountId,
  provider: AccountProvider,
  label: z.string().min(1).max(128),
  homeDir: AccountDirectory,
  env: z.partialRecord(AccountEnvKey, AccountDirectory),
});
export type ProviderInstance = z.infer<typeof ProviderInstance>;
export const QuotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().finite().nonnegative().nullable(),
});
export const AccountQuota = z.object({
  auth: z.enum(["logged_in", "logged_out", "unknown"]),
  observedAt: z.number().finite().nonnegative(),
  windows: z.record(z.string().max(128), QuotaWindow).refine((w) => Object.keys(w).length <= 32),
  blockers: z
    .object({ overflow: z.literal(true).optional(), limitError: QuotaWindow.optional() })
    .default({}),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .partial(),
});
export type AccountQuota = z.infer<typeof AccountQuota>;
export type QuotaWindow = z.infer<typeof QuotaWindow>;
export const AccountAvailability = z.enum([
  "available",
  "near_limit",
  "exhausted",
  "logged_out",
  "unknown",
]);
export const AccountSummary = z.object({
  id: AccountId,
  provider: AccountProvider,
  label: z.string().max(128),
  quota: AccountQuota,
  availability: AccountAvailability,
});
const cleanupWarnings = z
  .array(z.enum(["lease_release_failed", "staging_cleanup_failed", "rollback_failed"]))
  .max(3)
  .optional();
export const MigrationResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("migrated"),
    nativeSessionId: z.string().max(128),
    action: z.enum(["fork", "resume"]),
    copiedFiles: z.number().int().nonnegative(),
    cleanupWarnings,
  }),
  z.object({ status: z.literal("unsupported"), reason: z.string().max(512), cleanupWarnings }),
  z.object({ status: z.literal("refused"), reason: z.string().max(512), cleanupWarnings }),
]);
export type MigrationResult = z.infer<typeof MigrationResult>;
export const AccountsRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accounts.list"), requestId: z.string().max(128) }),
  z.object({
    type: z.literal("accounts.status"),
    requestId: z.string().max(128),
    instanceId: AccountId,
  }),
  z.object({
    type: z.literal("accounts.migrate"),
    requestId: z.string().max(128),
    provider: AccountProvider,
    nativeSessionId: z.string().max(128),
    from: AccountId,
    to: AccountId,
  }),
]);
export const AccountsResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("accounts.list"),
    requestId: z.string().max(128),
    accounts: z.array(AccountSummary).max(256),
  }),
  z.object({
    type: z.literal("accounts.status"),
    requestId: z.string().max(128),
    account: AccountSummary.nullable(),
  }),
  z.object({
    type: z.literal("accounts.migrate"),
    requestId: z.string().max(128),
    result: MigrationResult,
  }),
]);

export type AccountsRequest = z.infer<typeof AccountsRequest>;
export type AccountsResponse = z.infer<typeof AccountsResponse>;
