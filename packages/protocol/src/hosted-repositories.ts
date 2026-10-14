import { z } from "zod";
import { JsonValue } from "./json.ts";
import { WorkspaceId } from "./ids.ts";
import { ForgeRepository } from "./forge.ts";
import { GitHubHost, GitHubAccount } from "./source-control.ts";

export const RepositoryPublishInput = z.object({
  host: GitHubHost,
  account: GitHubAccount,
  owner: GitHubAccount,
  name: ForgeRepository.shape.name
    .refine((value) => value !== "." && value !== "..")
    .meta({ "x-ace-constraint": "Repository name differs from . and .." }),
  description: z.string().max(350),
  visibility: z.enum(["public", "private"]),
});
export type RepositoryPublishInput = z.infer<typeof RepositoryPublishInput>;
export const HostedRepository = z.object({
  raw: JsonValue.optional(),
  id: z.number().int().positive(),
  repository: ForgeRepository,
  description: z.string().max(4096),
  visibility: z.enum(["public", "private"]),
  archived: z.boolean(),
  fork: z.boolean(),
  url: z.string().max(4096),
  cloneUrl: z.string().max(4096),
});
export type HostedRepository = z.infer<typeof HostedRepository>;
export const RepositoryPublication = z.object({
  workspaceId: WorkspaceId,
  input: RepositoryPublishInput,
  phase: z.enum(["prepared", "creating", "remote_created", "origin_added", "empty", "pushed"]),
  remote: HostedRepository.nullable(),
  error: z.string().max(100).nullable(),
  updatedAt: z.number().nonnegative(),
});
export type RepositoryPublication = z.infer<typeof RepositoryPublication>;
export const RepositoryListInput = z.object({
  host: GitHubHost,
  account: GitHubAccount,
  owner: GitHubAccount.optional(),
  query: z.string().max(256),
  visibility: z.enum(["all", "public", "private"]),
  archived: z.enum(["all", "yes", "no"]),
  fork: z.enum(["all", "yes", "no"]),
});
export type RepositoryListInput = z.infer<typeof RepositoryListInput>;
export const HostedRepositoriesRequest = z.object({
  type: z.literal("repositories.request"),
  requestId: z.string().min(1).max(128),
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("list"), input: RepositoryListInput }),
    z.object({ op: z.literal("publication"), workspaceId: WorkspaceId }),
    z.object({ op: z.literal("publication.cancel"), workspaceId: WorkspaceId }),
  ]),
});
export type HostedRepositoriesRequest = z.infer<typeof HostedRepositoriesRequest>;
export const HostedRepositoriesResult = z.object({
  type: z.literal("repositories.result"),
  requestId: z.string().min(1).max(128),
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("repositories"),
      repositories: z.array(HostedRepository).max(2000),
      account: GitHubAccount,
      host: GitHubHost,
    }),
    z.object({
      kind: z.literal("publication"),
      publication: RepositoryPublication.nullable(),
      running: z.boolean().default(false),
      canStop: z.boolean().default(false),
    }),
    z.object({ kind: z.literal("error"), code: z.string().max(100) }),
  ]),
});
export type HostedRepositoriesResult = z.infer<typeof HostedRepositoriesResult>;
