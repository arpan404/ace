import * as z from "zod/mini";
import type { OpenRequest } from "@/lib/workspace/index.ts";

/** A pull request tab's identity, kept in local storage: decoded before it reaches a read. */
export const PullRequestTabData = z.object({
  state: z.optional(z.enum(["open", "draft", "closed", "merged", "unknown"])),
  workspaceId: z.string().check(z.minLength(1)),
  repository: z.optional(
    z.object({
      forge: z.enum(["github", "gitlab"]),
      host: z.string(),
      owner: z.string(),
      name: z.string(),
    }),
  ),
  number: z.number().check(z.int(), z.gte(1)),
});
export type PullRequestTabData = z.infer<typeof PullRequestTabData>;

const repositoryPath = (data: PullRequestTabData) =>
  data.repository ? `${data.repository.host}/${data.repository.owner}/${data.repository.name}` : "";

/**
 * The side panel tab that shows pull request `number` of `repository` in a project: one tab per
 * pull request, so opening it again shows the tab already open.
 */
export function pullRequestTab(pr: Omit<PullRequestTabData, "state">): OpenRequest {
  const data: PullRequestTabData = {
    workspaceId: pr.workspaceId,
    repository: pr.repository,
    number: pr.number,
  };
  return {
    kind: "pull-request",
    id: `${data.workspaceId}/${repositoryPath(data)}/${data.number}`,
    title: `#${data.number}`,
    data,
  };
}
