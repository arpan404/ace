import { z } from "zod";
import { ForgeCapabilities } from "./forge-capabilities.ts";
import { ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

/** The most repositories a project adds by hand. */
export const maxManualProjectRepositories = 32;
/** The most repositories a project hides. */
export const maxHiddenProjectRepositories = 64;
/** The most repositories one project lists: its remotes' and its manual ones. */
export const maxProjectRepositories = 128;

/**
 * A project's saved repository choices (ADR 0120). Repositories are compared by provider, host,
 * owner and name, without case. Absent (`null` on the wire) means no choices: the project uses
 * its remotes and today's primary rule.
 */
export const ProjectRepositoryConfig = z.object({
  /** Repositories added by hand, in the order shown; they need not be remotes. */
  added: z.array(ForgeRepository).max(maxManualProjectRepositories).default([]),
  /** Repositories the project doesn't use: not listed in Code review, never written to. */
  hidden: z.array(ForgeRepository).max(maxHiddenProjectRepositories).default([]),
  /**
   * Where new pull requests open and what single-repository features use. Null keeps the
   * default: the global remote name's repository, else the first visible one. Never hidden.
   */
  primary: ForgeRepository.nullable().default(null),
});
export type ProjectRepositoryConfig = z.infer<typeof ProjectRepositoryConfig>;

/** Why a listed repository can't be read or written now. */
export const ProjectRepositoryUnavailable = z.enum([
  /** A manual repository's host is neither public nor in source control settings. */
  "host_not_configured",
  /** Its host is configured with a different provider now. */
  "provider_mismatch",
  /** ace reads no pull requests from its provider yet. */
  "provider_unsupported",
  /** The saved primary, which no remote names any more. */
  "remote_missing",
]);
export type ProjectRepositoryUnavailable = z.infer<typeof ProjectRepositoryUnavailable>;

/** One repository of a project, as the daemon resolved it from remotes and saved choices. */
export const ProjectRepository = z.object({
  repository: ForgeRepository,
  /** `remote`: a remote of the checkout names it. `manual`: only added by hand. */
  source: z.enum(["remote", "manual"]),
  /** The remote that names it, when one does. */
  remote: z.string().min(1).max(256).optional(),
  /** Not hidden by the person. Clients list reviews only from visible, available ones. */
  visible: z.boolean(),
  /** The project's primary repository: exactly one entry is, or none. */
  primary: z.boolean(),
  available: z.boolean(),
  /** Set exactly when `available` is false. */
  unavailable: ProjectRepositoryUnavailable.optional(),
  /** What ace can do with this repository's host (ADR 0117). Absent from older daemons. */
  capabilities: ForgeCapabilities.optional(),
});
export type ProjectRepository = z.infer<typeof ProjectRepository>;

/**
 * `forge.repositories`: every repository the project lists. Remotes' first (the global remote
 * name's first of those), then manual ones in saved order; choosing a primary never reorders.
 */
export const ProjectRepositories = z.object({
  workspaceId: WorkspaceId,
  repositories: z.array(ProjectRepository).max(maxProjectRepositories),
  /** The primary's repository, the same as `forge.repository`; null when there is none. */
  primary: ForgeRepository.nullable(),
  /** The saved choices; null when the project has none. */
  config: ProjectRepositoryConfig.nullable(),
});
export type ProjectRepositories = z.infer<typeof ProjectRepositories>;

/**
 * Replace a project's repository choices; null clears them. Refused with `primary_hidden` when
 * the primary is also hidden, and with `repositories_changed` when `expected` no longer matches
 * the saved choices (another device saved meanwhile): the client reads `forge.repositories`
 * again and re-applies its one edit. Answers with the project, and every client is told through
 * `workspace.changed` (`updated`) to read `forge.repositories` again.
 */
export const ProjectRepositoriesSetCommand = z.object({
  type: z.literal("workspace.repositories.set"),
  workspaceId: WorkspaceId,
  repositories: ProjectRepositoryConfig.nullable(),
  /**
   * The saved choices the edit started from (`forge.repositories`' `config`; null for none).
   * Compared by identity, the order of `hidden` aside. Absent replaces whatever is saved.
   */
  expected: ProjectRepositoryConfig.nullable().optional(),
});
export type ProjectRepositoriesSetCommand = z.infer<typeof ProjectRepositoriesSetCommand>;
