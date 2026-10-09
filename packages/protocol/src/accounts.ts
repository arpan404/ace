import { NativeSessionId } from "./ids.ts";
import { z } from "zod";
import { AcpIdentity } from "./agent-registry.ts";
import { AccountId, AccountInstanceId } from "./account-ids.ts";

export { AccountId, AccountInstanceId } from "./account-ids.ts";

export const AccountBadgeColor = z.enum(["neutral", "blue", "green", "amber", "rose", "violet"]);
export type AccountBadgeColor = z.infer<typeof AccountBadgeColor>;
/** New badge input: at most two text graphemes, or one emoji/icon grapheme. */
export const AccountBadgeInput = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    if (/\s|\p{Cc}/u.test(value)) return false;
    const count = Array.from(
      new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
    ).length;
    const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value);
    return emoji ? count === 1 : count <= 2 && !/\p{Cf}/u.test(value);
  })
  .meta({
    "x-ace-constraint":
      "One or two non-whitespace text graphemes, or one emoji/icon grapheme, at most 64 UTF-16 code units.",
    examples: ["AB", "👩‍💻"],
  });
/** Older stored three-letter badges remain readable; mutations use AccountBadgeInput. */
export const AccountShortLabel = z.union([AccountBadgeInput, z.string().regex(/^\S{1,3}$/u)]);

export const NativeAccountProvider = z.enum(["codex", "claude", "opencode", "cursor", "pi"]);
export const AccountProvider = z.enum([...NativeAccountProvider.options, "acp"]);
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
  "PI_CODING_AGENT_DIR",
]);
export const ProviderInstance = z
  .object({
    id: AccountInstanceId,
    implicit: z.literal(true).optional(),
    managed: z.literal(true).optional(),
    ...AcpIdentity.partial().shape,
    homeStrategy: z.literal("default_cli").optional(),
    authMethod: z.enum(["browser", "api_key", "unknown"]).optional(),
    signedInAs: z.string().max(256).optional(),
    loginRevision: z.string().max(128).optional(),
    profileRevision: z.string().max(256).optional(),
    installationVersion: z.string().max(256).optional(),
    provider: AccountProvider,
    label: z.string().min(1).max(128),
    shortLabel: AccountShortLabel.optional(),
    badgeColor: AccountBadgeColor.optional(),
    homeDir: AccountDirectory,
    env: z.partialRecord(AccountEnvKey, AccountDirectory),
  })
  .superRefine((instance, ctx) => {
    if (
      instance.implicit &&
      (instance.managed || instance.provider === "acp" || Object.keys(instance.env).length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Implicit native CLI accounts have no isolated selectors",
      });
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
  remainingPercent: z.number().min(0).max(100).optional(),
  windowDurationMins: z.number().finite().positive().optional(),
  source: z.enum(["cli", "status_estimate", "limit_error"]).optional(),
});
export const CursorSdkAuth = z.strictObject({
  status: z.enum(["logged-in", "logged-out"]),
  source: z.enum(["environment", "sdk-store", "none"]),
});
export const AccountQuota = z.object({
  auth: z.enum(["logged_in", "logged_out", "unknown"]),
  cursorSdkAuth: CursorSdkAuth.optional(),
  observedAt: z.number().finite().nonnegative(),
  billingMode: z.enum(["api", "subscription", "unknown"]).optional(),
  plan: z.string().min(1).max(128).optional(),
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
  implicit: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  id: AccountInstanceId,
  ...AcpIdentity.partial().shape,
  homeStrategy: z.literal("default_cli").optional(),
  isolation: z.literal("unsupported").optional(),
  authMethod: z.enum(["browser", "api_key", "unknown"]).optional(),
  signedInAs: z.string().max(256).optional(),
  loginRevision: z.string().max(128).optional(),
  profileRevision: z.string().max(256).optional(),
  installationVersion: z.string().max(256).optional(),
  provider: AccountProvider,
  label: z.string().max(128),
  shortLabel: AccountShortLabel.optional(),
  badgeColor: AccountBadgeColor.optional(),
  quota: AccountQuota,
  availability: AccountAvailability,
  blockedUntil: z.number().finite().nonnegative().nullable().optional(),
});
export type AccountSummary = z.infer<typeof AccountSummary>;
const cleanupWarnings = z
  .array(z.enum(["lease_release_failed", "staging_cleanup_failed", "rollback_failed"]))
  .max(3)
  .optional();
export const MigrationResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("migrated"),
    nativeSessionId: NativeSessionId,
    action: z.enum(["fork", "resume"]),
    copiedFiles: z.number().int().nonnegative(),
    cleanupWarnings,
  }),
  z.object({ status: z.literal("unsupported"), reason: z.string().max(512), cleanupWarnings }),
  z.object({ status: z.literal("refused"), reason: z.string().max(512), cleanupWarnings }),
]);
export type MigrationResult = z.infer<typeof MigrationResult>;
export const AccountManagementRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("accounts.add"),
    requestId: z.string().max(128),
    provider: NativeAccountProvider,
    label: z.string().min(1).max(128).regex(/\S/),
    shortLabel: AccountBadgeInput.optional(),
  }),
  z.object({
    type: z.literal("accounts.rename"),
    requestId: z.string().max(128),
    instanceId: AccountInstanceId,
    label: z.string().min(1).max(128).regex(/\S/),
    shortLabel: AccountBadgeInput.optional(),
    badgeColor: AccountBadgeColor.nullable().optional(),
  }),
  z.object({
    type: z.literal("accounts.remove"),
    requestId: z.string().max(128),
    instanceId: AccountInstanceId,
    deleteHome: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("accounts.setDefault"),
    requestId: z.string().max(128),
    provider: NativeAccountProvider,
    instanceId: AccountInstanceId,
  }),
  z.object({
    type: z.literal("accounts.login"),
    requestId: z.string().max(128),
    instanceId: AccountInstanceId,
  }),
  z.object({
    type: z.literal("accounts.logout"),
    requestId: z.string().max(128),
    instanceId: AccountInstanceId,
  }),
]);
export type AccountManagementRequest = z.infer<typeof AccountManagementRequest>;
export const AccountsRequest = z.discriminatedUnion("type", [
  ...AccountManagementRequest.options,
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
    nativeSessionId: NativeSessionId,
    from: AccountInstanceId,
    to: AccountInstanceId,
  }),
]);
export const AccountsResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("accounts.changed"),
    requestId: z.string().max(128),
    account: AccountSummary.nullable(),
  }),
  z.object({
    type: z.literal("accounts.auth"),
    requestId: z.string().max(128),
    instanceId: AccountInstanceId,
    terminalId: z.string().min(1).max(128),
    instruction: z.enum(["/login", "/logout"]).optional(),
  }),
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
