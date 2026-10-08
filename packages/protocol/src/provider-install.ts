import { z } from "zod";
import { RegistryInstallPlan } from "./agent-registry.ts";
import { ProviderKind } from "./provider-data.ts";

const id = z.string().min(1).max(128);
export const InstallAgent = z.enum([
  "gemini",
  "qwen-code",
  "claude-acp",
  "codex-acp",
  "goose",
  "auggie",
]);
export type InstallAgent = z.infer<typeof InstallAgent>;
export const InstallAction = z.enum(["install", "update", "uninstall"]);
export type InstallAction = z.infer<typeof InstallAction>;
export const InstallMethod = z.enum(["npm", "bun", "brew", "script", "registry"]);
export type InstallMethod = z.infer<typeof InstallMethod>;
const target = {
  provider: ProviderKind,
  agent: InstallAgent.optional(),
  acpAgentId: z
    .string()
    .regex(/^official:[a-z0-9-]+$/)
    .max(256)
    .optional(),
};
export const InstallCommand = z.strictObject({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(16),
  display: z.string().max(8192),
});
export type InstallCommand = z.infer<typeof InstallCommand>;
export const ProviderInstallPlan = z.strictObject({
  ...target,
  action: InstallAction,
  status: z.enum(["ready", "manual", "sign_in", "unavailable"]),
  method: InstallMethod.optional(),
  methods: z.array(InstallMethod).max(5),
  registryPlan: RegistryInstallPlan.optional(),
  downloadOnly: z.literal(true).optional(),
  prerequisite: z.object({ name: z.string().max(128), sourceUrl: z.url().max(2048) }).optional(),
  commands: z.array(InstallCommand).max(4),
  verify: InstallCommand.optional(),
  sourceUrl: z.url().max(2048),
  needsAdmin: z.boolean(),
  versionCheckedAt: z.number().nonnegative().optional(),
  installedVersion: z.string().max(256).optional(),
  latestVersion: z.string().max(256).optional(),
  updateAvailable: z.boolean().optional(),
  message: z.string().max(1024).optional(),
});
export type ProviderInstallPlan = z.infer<typeof ProviderInstallPlan>;
export const ProviderInstallRequest = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("provider.install.plan"),
    requestId: id,
    ...target,
    action: InstallAction.default("install"),
  }),
  z.strictObject({
    type: z.literal("provider.install.run"),
    requestId: id,
    ...target,
    action: InstallAction,
    method: InstallMethod,
  }),
  z.strictObject({ type: z.literal("provider.install.poll"), requestId: id, session: id }),
  z.strictObject({ type: z.literal("provider.install.cancel"), requestId: id, session: id }),
]);
export type ProviderInstallRequest = z.infer<typeof ProviderInstallRequest>;
export const ProviderInstallProgress = z.strictObject({
  session: id,
  ...target,
  action: InstallAction,
  method: InstallMethod,
  state: z.enum([
    "planning",
    "running",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
    "needs_admin",
  ]),
  sequence: z.number().int().nonnegative(),
  step: z.number().int().min(0).max(4),
  plan: ProviderInstallPlan.optional(),
  lines: z.array(z.string().max(2048)).max(100),
  exit: z.number().int().nullable().optional(),
  version: z.string().max(256).optional(),
  message: z.string().max(1024).optional(),
});
export type ProviderInstallProgress = z.infer<typeof ProviderInstallProgress>;
export const ProviderInstallEvent = z.object({
  type: z.literal("provider.install.progress"),
  progress: ProviderInstallProgress,
});
export const ProviderInstallResult = z.object({
  type: z.literal("provider.install.result"),
  requestId: id,
  result: z.union([
    z.object({ ok: z.literal(true), plan: ProviderInstallPlan }),
    z.object({ ok: z.literal(true), progress: ProviderInstallProgress }),
    z.object({
      ok: z.literal(false),
      error: z.enum(["forbidden", "unavailable", "busy", "not_found", "invalid_method"]),
    }),
  ]),
});
export type ProviderInstallResult = z.infer<typeof ProviderInstallResult>;
