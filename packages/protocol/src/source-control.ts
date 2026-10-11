import { z } from "zod";
import { WorkspaceId } from "./ids.ts";

export const GitHubHost = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
  .max(253);
export const GitHubAccount = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
  .max(100);
export const SourceControlPreferences = z
  .object({
    hosts: z
      .array(z.object({ host: GitHubHost, account: GitHubAccount.optional() }))
      .min(1)
      .max(32),
    host: GitHubHost,
    remote: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .max(100),
  })
  .refine(
    (value) =>
      value.hosts.some((entry) => entry.host === value.host) &&
      new Set(value.hosts.map((entry) => entry.host)).size === value.hosts.length,
    "Select a configured, unique host",
  )
  .meta({
    "x-ace-constraint": "Hosts are unique and the selected host must be configured",
    examples: [{ hosts: [{ host: "github.com" }], host: "github.com", remote: "origin" }],
  });
export type SourceControlPreferences = z.infer<typeof SourceControlPreferences>;
export const SourceControlReadiness = z.object({
  preferences: SourceControlPreferences,
  cli: z.enum(["available", "unavailable"]),
  version: z.string().max(256).nullable(),
  accounts: z.array(z.object({ login: GitHubAccount, active: z.boolean() })).max(100),
  account: GitHubAccount.nullable(),
  api: z.enum(["ready", "login_required", "account_mismatch", "unavailable"]),
  instructions: z.string().max(512),
  transport: z.enum(["unchecked", "ready", "failed", "no_remote"]),
  transportInstructions: z.string().max(512),
});
export type SourceControlReadiness = z.infer<typeof SourceControlReadiness>;
export const SourceControlRequest = z.object({
  type: z.literal("source-control.request"),
  requestId: z.string().min(1).max(128),
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("readiness"), workspaceId: WorkspaceId.optional() }),
  ]),
});
export type SourceControlRequest = z.infer<typeof SourceControlRequest>;
export const SourceControlResult = z.object({
  type: z.literal("source-control.result"),
  requestId: z.string().min(1).max(128),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("readiness"), readiness: SourceControlReadiness }),
    z.object({ kind: z.literal("error"), code: z.string().max(100) }),
  ]),
});
export type SourceControlResult = z.infer<typeof SourceControlResult>;
