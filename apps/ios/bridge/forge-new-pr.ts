import {
  ForgeBranchName,
  ForgeHostedPrCreateCommand,
  ForgeRepository,
  ForgeRepositoryName,
  type ForgeRepoPrOptions,
  WorkspaceId,
} from "@ace/protocol";
import { actionErrorText, milestoneDue, repositoryLabel, reviewRepositories } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * Opening a pull request from any branch of a project, as the web's New pull request page does:
 * the branches it can come from and go into, what a pull request of two of them would hold, who
 * may review it and how it may be filed, then the create. The daemon answers an open pull request of the same branches instead of opening a
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
/** How many of each detail GitHub takes on a new pull request, as the create command admits. */
const most = { reviewers: 100, assignees: 10, labels: 100 };
export const ForgeNewPrCreateRequest = z.object({
  type: z.literal("forge.newpr.create"),
  project: z.string().min(1).max(512),
  repository: ForgeRepository,
  base: ForgeBranchName,
  head: ForgeNewPrCompareRequest.shape.head,
  title: z.string().min(1).max(256).regex(/\S/),
  body: z.string().max(65_536),
  draft: z.boolean(),
  reviewers: ForgeHostedPrCreateCommand.shape.reviewers,
  assignees: ForgeHostedPrCreateCommand.shape.assignees,
  labels: ForgeHostedPrCreateCommand.shape.labels,
  milestone: ForgeHostedPrCreateCommand.shape.milestone,
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
  /** "Opens on GitLab · acme/ace", only when the project uses more than one repository. */
  opensOn: string | null;
  /** What the pull request may be given besides its text; null when GitHub didn't say. */
  details: NewPrDetails | null;
}
export interface NewPrDetails {
  /** People GitHub lets be assigned; the same people can be asked to review. */
  people: string[];
  labels: { name: string; color: string | null; description: string }[];
  /** Open milestones, with "Due Nov 20, 2026" where one is set. */
  milestones: { number: number; title: string; due: string | null }[];
  /** How many of each GitHub takes. */
  most: typeof most;
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
  // New pull requests open on the primary; with several repositories the sheet says which.
  const [several, options] = await Promise.all([
    reads
      .repositories(request.project)
      .then((listed) => reviewRepositories(listed).length > 1)
      .catch(() => false),
    // The details are extras: without them a pull request still opens with its text alone.
    reads
      .read({ op: "forge.repo.pr-options", workspaceId: request.project }, true)
      .then((read) => (read.resource === "repoPrOptions" ? read.value : null))
      .catch(() => null),
  ]);
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
    opensOn: several ? `Opens on ${repositoryLabel(context.base.repository)}` : null,
    details: options ? newPrDetails(options, preview) : null,
  };
}

function newPrDetails(options: ForgeRepoPrOptions, preview: Preview): NewPrDetails {
  return {
    people: options.assignable.map((person) => person.login),
    labels: options.labels.map((label) => ({
      name: label.name,
      color: label.color ?? null,
      description: preview(label.description, 300),
    })),
    milestones: options.milestones
      .filter((milestone) => milestone.state === "open")
      .map((milestone) => ({
        number: milestone.number,
        title: preview(milestone.title, 200),
        due: milestoneDue(milestone.dueOn),
      })),
    most,
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
    reviewers: request.reviewers,
    assignees: request.assignees,
    labels: request.labels,
    ...(request.milestone ? { milestone: request.milestone } : {}),
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
