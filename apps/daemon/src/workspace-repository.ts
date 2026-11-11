import type {
  ForgeRepository,
  ProjectRepositoryConfig,
  SourceControlPreferences,
} from "@ace/protocol";
import { resolveProjectRepositories, type CheckoutRemote } from "@ace/forge";

/**
 * The project's primary repository (ADR 0116): one selection rule for published checkout
 * details and forge commands. Without saved choices it is the global remote name's
 * repository, else (with no preferences) the first remote's.
 */
export function workspaceRepository(
  remotes: readonly CheckoutRemote[],
  preferences?: SourceControlPreferences,
  /** SSH host aliases resolved to real hosts, from `SourceControl.hostAliases`. */
  aliases: Readonly<Record<string, string>> = {},
  config?: ProjectRepositoryConfig,
): ForgeRepository | undefined {
  return resolveProjectRepositories({ remotes, preferences, aliases, config }).primary?.repository;
}
