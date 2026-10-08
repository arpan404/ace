import { z } from "zod";
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AcpIdentity = z.object({
  acpAgentId: id,
  installationId: id,
  instanceId: id,
});
export type AcpIdentity = z.infer<typeof AcpIdentity>;
export const RegistryAgent = z.object({
  acpAgentId: id,
  name: z.string().min(1).max(512),
  version: id,
  description: z.string().max(8192),
  source: z.url().max(4096),
  authors: z.array(z.string().max(256)).max(64),
  availability: z.enum(["available", "unsupported_distribution", "unsupported_target"]),
  coverage: z.enum(["source_profile", "generic"]),
  auth: z.literal("unknown"),
  loginHint: z.string().max(512),
  visibility: z.literal("limited"),
  isolation: z.literal("unsupported"),
  /** The upstream HTTPS icon URL; clients fetch it, the daemon never does. */
  icon: z.url().max(4096).optional(),
  /** Install runtimes this entry offers for the daemon's platform, best first. */
  runtimes: z
    .array(z.enum(["binary", "npm", "uv"]))
    .max(3)
    .optional(),
  /** The upstream website, else its repository. */
  homepage: z.url().max(4096).optional(),
  license: z.string().max(256).optional(),
});
export type RegistryAgent = z.infer<typeof RegistryAgent>;
export const RegistryInstallation = AcpIdentity.extend({
  version: id,
  profileRevision: id,
  source: z.string().max(4096),
  evidence: z.enum(["user_local_binding", "sha256", "package_manager", "unsigned_https"]),
  packageManager: z
    .object({
      command: z.string().max(4096),
      package: z.string().max(1024),
      integrity: z.string().max(1024).optional(),
    })
    .optional(),
});
export type RegistryInstallation = z.infer<typeof RegistryInstallation>;
export const RegistryInstallPlan = z.object({
  digest,
  acpAgentId: id,
  version: id,
  source: z.url().max(4096),
  publisher: z.array(z.string().max(256)).max(64),
  runtime: z.enum(["binary", "npm", "uv"]),
  target: id,
  destination: z.string().max(4096),
  argv: z.array(z.string().max(4096)).max(128),
  verification: z.enum(["sha256", "unsigned_https", "package_manager"]),
});
export type RegistryInstallPlan = z.infer<typeof RegistryInstallPlan>;
export const RegistryRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("registry.list"),
    requestId: id,
    offset: z.number().int().min(0).max(2048).default(0),
    limit: z.number().int().min(1).max(50).default(50),
  }),
  z.object({ type: z.literal("registry.refresh"), requestId: id }),
  z.object({
    type: z.literal("registry.bind"),
    requestId: id,
    ...AcpIdentity.shape,
    version: id,
    command: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => Array.from(value).every((char) => char.charCodeAt(0) >= 32))
      .meta({ "x-ace-constraint": "Commands cannot contain control characters." }),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0"))
          .meta({ "x-ace-constraint": "Arguments cannot contain NUL." }),
      )
      .max(64),
    underlyingCommand: z.string().min(1).max(4096).optional(),
  }),
  z.object({
    type: z.literal("registry.install-plan"),
    requestId: id,
    acpAgentId: id,
    runtime: z.enum(["binary", "npm", "uv"]),
  }),
  z.object({ type: z.literal("registry.install-intent"), requestId: id, digest, intentId: id }),
  z.object({ type: z.literal("registry.install-cancel"), requestId: id, intentId: id }),
]);
export type RegistryRequest = z.infer<typeof RegistryRequest>;
export const RegistryInstallProgress = z.object({
  intentId: id,
  digest,
  phase: z.enum(["preparing", "download", "extract", "package_manager", "persist"]),
  receivedBytes: z
    .number()
    .int()
    .min(0)
    .max(128 * 1024 * 1024),
});
export type RegistryInstallProgress = z.infer<typeof RegistryInstallProgress>;
export const RegistryResult = z.object({
  type: z.literal("registry.result"),
  requestId: id,
  result: z.union([
    z.object({ ok: z.literal(false), reason: z.string().max(512) }),
    z.object({
      ok: z.literal(true),
      agents: z.array(RegistryAgent).max(50),
      installations: z.array(RegistryInstallation).max(512),
      stale: z.boolean(),
      refreshing: z.boolean(),
      activeInstall: RegistryInstallProgress.optional(),
      error: z.enum(["refresh_failed", "cache_failed"]).optional(),
      source: z.string().max(4096),
      digest: digest.optional(),
      fetchedAt: z.number().nonnegative().optional(),
      schemaVersion: z.string().max(128).optional(),
      release: z.string().max(256).optional(),
      nextOffset: z.number().int().nonnegative().optional(),
    }),
    z.object({ ok: z.literal(true), plan: RegistryInstallPlan }),
    z.object({
      ok: z.literal(true),
      installation: RegistryInstallation,
      durability: z.literal("uncertain").optional(),
    }),
    z.object({ ok: z.literal(true), cancelled: z.boolean() }),
  ]),
});
export type RegistryResult = z.infer<typeof RegistryResult>;
export const AcpSessionSupport = z.object({
  capabilities: z.object({ resume: z.boolean(), imageInput: z.boolean(), planMode: z.boolean() }),
  mcp: z.enum(["http", "stdio", "unavailable"]),
  modelSelection: z.boolean(),
  modeSelection: z.boolean(),
  subagentSessions: z.boolean().default(false),
  coverage: z.enum(["source_profile", "generic", "legacy"]),
  visibility: z.literal("limited"),
  raw: z.object({ json: z.string().max(2048), truncated: z.boolean() }),
});
export type AcpSessionSupport = z.infer<typeof AcpSessionSupport>;
