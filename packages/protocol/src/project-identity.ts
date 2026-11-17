import { z } from "zod";
import { WorkspaceId } from "./ids.ts";

/*
 * Logical project identity (docs/adr/0180-logical-project-identity.md): one project the person
 * knows, above the machine-local registrations (`Project`, a daemon workspace) that check it
 * out. A registration's identity is a grouping its own daemon keeps, never an authority: it is
 * set by the daemon (on add, clone or create), by an explicit link, merge or unlink the person
 * confirmed, or by a transfer from one of the person's paired machines. Remotes only ever
 * suggest; nothing links on its own. A registration without an identity is its own project.
 */

/** A logical project's id: a UUID in lower-case canonical form, so two spellings never differ. */
export const ProjectIdentityId = z
  .uuid()
  .regex(/^[0-9a-f-]+$/)
  .meta({ "x-ace-constraint": "A UUID in lower-case canonical form." });
export type ProjectIdentityId = z.infer<typeof ProjectIdentityId>;

/**
 * How the registration got its identity: `created` minted by its daemon (a new project, or an
 * unlink), `linked` by a link or merge the person confirmed, `transfer` taken from the paired
 * machine a transfer came from, `marker` from a project marker the person confirmed.
 */
export const ProjectIdentitySource = z.enum(["created", "linked", "transfer", "marker"]);
export type ProjectIdentitySource = z.infer<typeof ProjectIdentitySource>;

/** The most aliases one registration reports; the most recent merges are the ones kept. */
export const maxIdentityAliases = 32;

/**
 * A registration's logical project. `aliases` are identities merged into `id` on this daemon:
 * a client groups registrations on every machine as connected components of ids and aliases,
 * so a machine that was offline during a merge, still reporting the old id, joins the group.
 */
export const ProjectIdentity = z.object({
  id: ProjectIdentityId,
  aliases: z.array(ProjectIdentityId).max(maxIdentityAliases),
  source: ProjectIdentitySource,
});
export type ProjectIdentity = z.infer<typeof ProjectIdentity>;

/*
 * Commands, under the `projects` authority, each idempotent under its command id and each
 * pushing `workspace.changed` for every registration whose identity it changed.
 */
export const ProjectIdentityCommands = [
  /** Put one registration in the logical project `identityId`. It records no alias. */
  z.object({
    type: z.literal("workspace.identity.link"),
    workspaceId: WorkspaceId,
    identityId: ProjectIdentityId,
  }),
  /** Split one registration off into a fresh logical project of its own. Aliases stay. */
  z.object({ type: z.literal("workspace.identity.unlink"), workspaceId: WorkspaceId }),
  /**
   * Merge logical project `from` into `into` on this daemon: every registration of `from` here
   * becomes `into`, and `from` is kept as an alias of `into`. `from` equal to `into` changes
   * nothing. Clients send it to every machine that keeps identities.
   */
  z.object({
    type: z.literal("workspace.identity.merge"),
    from: ProjectIdentityId,
    into: ProjectIdentityId,
  }),
] as const;

const normalizedRemote = z.string().min(1).max(4096);
/** A path inside a repository, `/`-separated, without a leading or trailing slash; "" is its root. */
const subpath = z.string().max(4096);

/*
 * Requests (`workspace.request`): what a client needs to suggest links. A daemon older than
 * identity refuses them as `invalid_message`, which the client reads as "keeps no identities".
 */
export const ProjectIdentityOperations = [
  /**
   * What a registration is a checkout of: every remote's fetch URLs, as `normalizeRemoteUrl`
   * keys, and its folder inside the repository. `repository: false` for a folder outside Git.
   */
  z.object({ op: z.literal("workspace.checkout"), workspaceId: WorkspaceId }),
  /**
   * Registrations here that may be the same logical project as a checkout elsewhere: one that
   * shares any remote with `remotes` and sits at the same `subpath`. Reads at most `limit`
   * registrations' remotes, in id order after `after`; `next` continues. Empty `remotes` asks
   * nothing and answers at once.
   */
  z.object({
    op: z.literal("workspaces.identitySuggestions"),
    remotes: z.array(normalizedRemote).max(64),
    subpath,
    after: WorkspaceId.optional(),
    limit: z.number().int().min(1).max(64).default(32),
  }),
] as const;

export const ProjectCheckoutFacts = z.object({
  repository: z.boolean(),
  remotes: z.array(normalizedRemote).max(64),
  subpath,
});
export type ProjectCheckoutFacts = z.infer<typeof ProjectCheckoutFacts>;

export const ProjectIdentitySuggestion = z.object({
  workspaceId: WorkspaceId,
  /** The remotes it shares with the asked-for set. */
  shared: z.array(normalizedRemote).max(64),
  /** Its remotes are exactly the asked-for set; false reads as "fork of …", never linked alone. */
  sameRemotes: z.boolean(),
});
export type ProjectIdentitySuggestion = z.infer<typeof ProjectIdentitySuggestion>;

export const ProjectIdentityResults = [
  z.object({ kind: z.literal("checkout"), checkout: ProjectCheckoutFacts }),
  z.object({
    kind: z.literal("identitySuggestions"),
    suggestions: z.array(ProjectIdentitySuggestion).max(64),
    next: WorkspaceId.nullable(),
  }),
] as const;
