import { repositoryFromRemote } from "@ace/forge";
import type { ForgeRepository, SourceControlPreferences } from "@ace/protocol";

/** One remote selection rule for both published checkout details and forge commands. */
export function workspaceRepository(
  remotes: readonly { name: string; fetchUrls: readonly string[] }[],
  preferences?: SourceControlPreferences,
): ForgeRepository | undefined {
  const remote = (
    remotes.find((entry) => entry.name === (preferences?.remote ?? "origin")) ??
    (preferences ? undefined : remotes[0])
  )?.fetchUrls[0];
  if (!remote) return undefined;
  try {
    return repositoryFromRemote(remote, preferences
      ? Object.fromEntries(preferences.hosts.map((entry) => [entry.host, "github"]))
      : {});
  } catch {
    return undefined;
  }
}
