import type { ForgeKind } from "@ace/protocol";

/** What the provider calls a review: GitLab's merge requests, everyone else's pull requests. */
export function reviewNoun(forge: ForgeKind | undefined): string {
  return forge === "gitlab" ? "merge request" : "pull request";
}
