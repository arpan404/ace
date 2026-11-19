import { z } from "zod";
import {
  ForgeRepository,
  configuredForge,
  originApiHost,
  publicForgeHosts,
  type ForgeKind,
} from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

export const GitHubHost = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
  .max(253);
export const GitHubAccount = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
  .max(100);
export const ForgeAccount = z.union([
  z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    .max(100),
  z.email().max(254),
]);
export const SourceControlHost = z.object({
  host: GitHubHost,
  /** Absent: the public host's provider, else GitHub (settings saved before providers existed). */
  forge: ForgeRepository.shape.forge.optional(),
  account: ForgeAccount.optional(),
});
export type SourceControlHost = z.infer<typeof SourceControlHost>;

/** The refusal for a provider that contradicts its host, which clients show as written. */
export const providerMismatchMessage =
  "A host's provider must match the host: github.com is GitHub, gitlab.com is GitLab, and Cursor Origin is only origin.cursor.com";

/** An explicit provider must agree with a public host's fixed one; Origin has one host. */
function providerMatchesHost(entry: { host: string; forge?: ForgeKind | undefined }): boolean {
  const fixed = publicForgeHosts[entry.host];
  const forge = configuredForge(entry);
  return (!fixed || forge === fixed) && (forge !== "origin" || entry.host === originApiHost);
}
export const SourceControlPreferences = z
  .object({
    hosts: z.array(SourceControlHost).min(1).max(32),
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
  .refine((value) => value.hosts.every(providerMatchesHost), providerMismatchMessage)
  .refine(
    (value) =>
      value.hosts.every(
        (entry) =>
          configuredForge(entry) !== "github" ||
          !entry.account ||
          GitHubAccount.safeParse(entry.account).success,
      ),
    "Enter a valid GitHub account name",
  )
  .meta({
    "x-ace-constraint":
      "Hosts are unique, the selected host must be configured, and a public host keeps its own provider",
    examples: [{ hosts: [{ host: "github.com" }], host: "github.com", remote: "origin" }],
  });
export type SourceControlPreferences = z.infer<typeof SourceControlPreferences>;
export const SourceControlReadiness = z.object({
  preferences: SourceControlPreferences,
  cli: z.enum(["available", "unavailable"]),
  version: z.string().max(256).nullable(),
  accounts: z.array(z.object({ login: ForgeAccount, active: z.boolean() })).max(100),
  account: ForgeAccount.nullable(),
  /** `offline` and `rate_limited` are network and quota answers, never sign-in problems. */
  api: z.enum([
    "ready",
    "login_required",
    "account_mismatch",
    "offline",
    "rate_limited",
    "unavailable",
  ]),
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
