import { z } from "zod";
import { AcpIdentity } from "./agent-registry.ts";

export const NativeAccountProvider = z.enum(["codex", "claude", "opencode", "cursor"]);
export const AccountProvider = z.enum([...NativeAccountProvider.options, "acp"]);
export const AccountInstanceId = z.string().min(1).max(256);
export const AccountId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const AccountAssignment = z.object({
  instanceId: AccountInstanceId.optional(),
  role: z.string().min(1).max(64),
  estimatedLoad: z.number().finite().min(0).max(100),
});
export type AccountAssignment = z.infer<typeof AccountAssignment>;
export const AccountDirectory = z
  .string()
  .max(4096)
  .regex(/^(?:\/|[A-Za-z]:[\\/])/s)
  .meta({
    "x-ace-constraint": "Absolute Unix or drive-qualified Windows directory.",
    examples: ["/example/home"],
  });
export const AccountEnvKey = z.enum([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CURSOR_DATA_DIR",
]);
export const ProviderInstance = z
  .object({
    id: AccountInstanceId,
    ...AcpIdentity.partial().shape,
    homeStrategy: z.literal("default_cli").optional(),
    loginRevision: z.string().max(128).optional(),
    profileRevision: z.string().max(256).optional(),
    installationVersion: z.string().max(256).optional(),
    provider: AccountProvider,
    label: z.string().min(1).max(128),
    homeDir: AccountDirectory,
    env: z.partialRecord(AccountEnvKey, AccountDirectory),
  })
  .superRefine((instance, ctx) => {
    if (instance.provider === "acp") {
      if (
        !AcpIdentity.safeParse(instance).success ||
        instance.instanceId !== instance.id ||
        instance.homeStrategy !== "default_cli" ||
        Object.keys(instance.env).length
      )
        ctx.addIssue({
          code: "custom",
          message: "ACP identity requires a CLI-owned default home and no unverified selectors",
        });
    } else if (
      !AccountId.safeParse(instance.id).success ||
      instance.acpAgentId ||
      instance.installationId ||
      instance.instanceId ||
      instance.homeStrategy
    )
      ctx.addIssue({ code: "custom", message: "Invalid native account identity" });
  })
  .meta({
    "x-ace-constraint":
      "Native instances use native account IDs. ACP instances require matching agent, installation and instance references, id equal to instanceId, default_cli home strategy and an empty selector environment.",
    examples: [
      {
        id: "codex-default",
        provider: "codex",
        label: "Codex",
        homeDir: "/example/codex",
        env: { CODEX_HOME: "/example/codex" },
      },
      {
        id: "installed:default",
        instanceId: "installed:default",
        provider: "acp",
        acpAgentId: "local:agent",
        installationId: "installed",
        label: "Local agent",
        homeDir: "/example/home",
        homeStrategy: "default_cli",
        env: {},
      },
    ],
  });
export type ProviderInstance = z.infer<typeof ProviderInstance>;
export const QuotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().finite().nonnegative().nullable(),
});
export const AccountQuota = z.object({
  auth: z.enum(["logged_in", "logged_out", "unknown"]),
  observedAt: z.number().finite().nonnegative(),
  windows: z
    .record(z.string().max(128), QuotaWindow)
    .refine((w) => Object.keys(w).length <= 32)
    .meta({ maxProperties: 32, "x-ace-constraint": "At most 32 quota windows." }),
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
  id: AccountInstanceId,
  ...AcpIdentity.partial().shape,
  homeStrategy: z.literal("default_cli").optional(),
  isolation: z.literal("unsupported").optional(),
  loginRevision: z.string().max(128).optional(),
  profileRevision: z.string().max(256).optional(),
  installationVersion: z.string().max(256).optional(),
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
    instanceId: AccountInstanceId,
  }),
  z.object({
    type: z.literal("accounts.migrate"),
    requestId: z.string().max(128),
    provider: AccountProvider,
    nativeSessionId: z.string().max(128),
    from: AccountInstanceId,
    to: AccountInstanceId,
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
