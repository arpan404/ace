import { ForgeRepository } from "@ace/protocol/forge";
import { workKey } from "@ace/ui-core";
import * as z from "zod/mini";
import type { OpenRequest } from "./model.ts";

/** A pull request tab's identity, kept in local storage: decoded before it reaches a read. */
export const PullRequestTabData = z.object({
  state: z.optional(z.enum(["open", "draft", "closed", "merged", "unknown"])),
  workspaceId: z.string().check(z.minLength(1)),
  repository: z.optional(ForgeRepository),
  number: z.number().check(z.int(), z.gte(1)),
});
export type PullRequestTabData = z.infer<typeof PullRequestTabData>;

/**
 * The side panel tab that shows pull request `number` of `repository` in a project: one tab per
 * pull request, so opening it again shows the tab already open. The id names the provider too,
 * so a host whose provider changes never reopens a tab read through the old one.
 */
export function pullRequestTab(pr: Omit<PullRequestTabData, "state">): OpenRequest {
  const data: PullRequestTabData = {
    workspaceId: pr.workspaceId,
    repository: pr.repository,
    number: pr.number,
  };
  return {
    kind: "pull-request",
    id: `${data.workspaceId}/${data.repository ? workKey(data.repository, data.number) : data.number}`,
    title: `#${data.number}`,
    data,
  };
}
