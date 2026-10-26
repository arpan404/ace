import {
  ForgeBranchName,
  ForgeHostedPrCreateCommand,
  ForgeRepository,
  ForgeRepositoryName,
  WorkspaceId,
} from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * Opening a pull request from any branch of a project, as the web's New pull request page does:
 * the branches it can come from and go into, what a pull request of two of them would hold, then
 * the create. The daemon answers an open pull request of the same branches instead of opening a
 * second one, so a create whose answer was lost is checked, never sent twice.
 */

export const ForgeNewPrContextRequest = z.object({
  type: z.literal("forge.newpr.context"),
  project: z.string().min(1).max(512),
});
export const ForgeNewPrCompareRequest = z.object({
  type: z.literal("forge.newpr.compare"),
  project: z.string().min(1).max(512),
  repository: ForgeRepository,
  base: ForgeBranchName,
  head: z.object({
    owner: z
      .string()
      .regex(/^[\w-]+$/)
      .max(100),
    name: ForgeRepositoryName,
    branch: ForgeBranchName,
  }),
});
export const ForgeNewPrCreateRequest = z.object({
  type: z.literal("forge.newpr.create"),
  project: z.string().min(1).max(512),
  repository: ForgeRepository,
  base: ForgeBranchName,
  head: ForgeNewPrCompareRequest.shape.head,
  title: z.string().min(1).max(256).regex(/\S/),
  body: z.string().max(65_536),
  draft: z.boolean(),
});
export type ForgeNewPrContextRequest = z.infer<typeof ForgeNewPrContextRequest>;
export type ForgeNewPrCompareRequest = z.infer<typeof ForgeNewPrCompareRequest>;
export type ForgeNewPrCreateRequest = z.infer<typeof ForgeNewPrCreateRequest>;

export interface NewPrContextReply {
  type: "forge.newpr.context";
  repository: ForgeRepository;
  defaultBranch: string;
  bases: string[];
  head: { owner: string; name: string; branches: string[] };
  template: string;
}
export interface NewPrCompareReply {
  type: "forge.newpr.compare";
  /** What the comparison says, in words: "3 commits, 5 files changed". */
  summary: string;
  /** Why a pull request can't be opened from these branches, when it can't. */
  blocked: string | null;
  /** The open pull request these branches already have. */
  existing: number | null;
  commits: { sha: string; title: string }[];
}
export interface NewPrCreateReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
  /** The pull request opened, or the one the branches already had. */
  number: number | null;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

export async function readNewPrContext(
  reads: ForgeReads,
  request: ForgeNewPrContextRequest,
  preview: Preview,
): Promise<NewPrContextReply> {
  const value = await reads.read(
    { op: "forge.pr.new-context", workspaceId: request.project },
    true,
  );
  if (value.resource !== "newPrContext") throw new ForgeRefusal("forge_invalid_data");
  const context = value.value;
  return {
    type: "forge.newpr.context",
    repository: context.base.repository,
    defaultBranch: context.base.defaultBranch,
    bases: context.base.branches.map((branch) => preview(branch.name, 256)),
    head: {
      owner: context.head.repository.owner,
      name: context.head.repository.name,
      branches: context.head.branches
        .map((branch) => preview(branch.name, 256))
        .filter(
          (name) =>
            name !== context.base.defaultBranch ||
            context.head.repository.owner !== context.base.repository.owner,
        ),
    },
    template: preview(context.template ?? "", 65_536),
  };
}

export async function readNewPrCompare(
  reads: ForgeReads,
  request: ForgeNewPrCompareRequest,
  preview: Preview,
): Promise<NewPrCompareReply> {
  const value = await reads.read(
    {
      op: "forge.compare",
      workspaceId: request.project,
      repository: request.repository,
      base: request.base,
      head: request.head,
      page: 1,
    },
    true,
  );
  if (value.resource !== "compare") throw new ForgeRefusal("forge_invalid_data");
  const compare = value.value;
  const blocked =
    compare.status === "identical" || compare.aheadBy === 0
      ? `${request.head.branch} has nothing ${request.base} doesn't already have.`
      : null;
  return {
    type: "forge.newpr.compare",
    summary: `${plural(compare.totalCommits, "commit")}, ${plural(compare.totalFiles, "file")} changed`,
    blocked,
    existing: compare.existingPr ?? null,
    commits: compare.commits.slice(-50).map((commit) => ({
      sha: commit.sha.slice(0, 7),
      title: preview(commit.message.split("\n")[0] ?? "", 300),
    })),
  };
}

export async function createPr(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeNewPrCreateRequest,
): Promise<NewPrCreateReply> {
  const command = ForgeHostedPrCreateCommand.parse({
    type: "forge.hosted.pr.create",
    workspaceId: WorkspaceId.parse(request.project),
    repository: request.repository,
    base: request.base,
    head: request.head,
    title: request.title,
    body: request.body,
    draft: request.draft,
  });
  try {
    const result = await owner.command(command);
    reads.forget(request.project);
    if (!result.ok && !result.pr)
      return {
        type: "forge.write",
        ok: false,
        message: actionErrorText(result.error),
        uncertain: false,
        number: null,
      };
    return {
      type: "forge.write",
      ok: true,
      // Opened, with what GitHub refused afterwards (reviewers, labels) said in words.
      message: result.prExisting
        ? "These branches already have an open pull request."
        : result.code
          ? actionErrorText(result.code)
          : "",
      uncertain: false,
      number: result.pr?.number ?? null,
    };
  } catch {
    reads.forget(request.project);
    return {
      type: "forge.write",
      ok: false,
      message:
        "Couldn't confirm it opened. Open New pull request again: an existing one is shown, never a second.",
      uncertain: true,
      number: null,
    };
  }
}
