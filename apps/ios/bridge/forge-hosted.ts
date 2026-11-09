import { ForgeRepository, type ForgePrDetail, type ForgePrFiles } from "@ace/protocol";
import {
  forgeDisplayName,
  hostedFilesUnavailableText,
  hostedLinks,
  hostedReviewLine,
  reviewNoun,
  type HostedLinks,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail, scopeOf, type PrTarget } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * A review on a host ace only reads (GitLab, Cursor Origin): what the phone's read-only page
 * says and links, in the web's words (`pr-hosted-reader.tsx`), and its changed files a page at
 * a time. Nothing here offers or sends a write: the daemon refuses them for these hosts.
 */

export interface HostedView {
  /** The provider's name: "GitLab", "Cursor Origin". */
  provider: string;
  noun: string;
  /** The one sentence under the header. */
  line: string;
  /** Said in place of the files when the host doesn't share them; null when it does. */
  filesUnavailable: string | null;
  links: HostedLinks;
}

export function hostedView(
  detail: Pick<ForgePrDetail, "status" | "unavailableResources">,
): HostedView {
  const { repository } = detail.status.ref;
  const provider = forgeDisplayName(repository.forge);
  const noun = reviewNoun(repository.forge);
  return {
    provider,
    noun,
    line: hostedReviewLine(repository.forge),
    filesUnavailable: detail.unavailableResources?.includes("files")
      ? hostedFilesUnavailableText(repository.forge)
      : null,
    links: hostedLinks(repository),
  };
}

/**
 * Where the phone keeps a review's unsent summary: provider, host, repository and number, so
 * the same owner/name/number on two hosts never share one. `legacy` is the GitHub key phones
 * kept before providers existed, read once so a summary saved then isn't lost.
 */
export function reviewDraftKeys(
  repository: ForgeRepository,
  number: number,
): { key: string; legacy: string | null } {
  const { forge, host, owner, name } = repository;
  return {
    key: `ace.forge.review.${forge}@${host}/${owner}/${name}#${number}`,
    legacy: forge === "github" ? `ace.forge.review.${owner}/${name}#${number}` : null,
  };
}

export const ForgeHostedFilesRequest = z.object({
  type: z.literal("forge.pull.hosted-files"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  page: z.number().int().positive().max(1_000).default(1),
  /** The head the phone showed this page at; a moved head starts again at page 1. */
  headSha: z
    .string()
    .regex(/^[a-fA-F0-9]{40,64}$/)
    .optional(),
});
export type ForgeHostedFilesRequest = z.infer<typeof ForgeHostedFilesRequest>;

export interface HostedFilesReply {
  type: "forge.pull.hosted-files";
  headSha: string;
  page: number;
  /** The branch moved since the phone's page was read: this is page 1 of its new changes. */
  moved: boolean;
  files: { path: string; status: string; additions: number; deletions: number }[];
  nextPage: number | null;
  /** Said under the list when the host left changes out. */
  truncated: string | null;
  /** Said in place of the list when the host doesn't share files. */
  unavailable: string | null;
}

async function filesAt(
  reads: ForgeReads,
  target: PrTarget,
  detail: ForgePrDetail,
  page: number,
): Promise<ForgePrFiles> {
  const value = await reads.read(
    {
      op: "forge.pr.files",
      ...scopeOf(target),
      page,
      headSha: detail.status.headSha,
      baseSha: detail.baseSha,
    },
    true,
  );
  if (value.resource !== "prFiles") throw new ForgeRefusal("forge_invalid_data");
  return value.value;
}

/**
 * One page of a read-only review's changed files at its current head. A head that moved since
 * the phone looked, or moves while the page reads, starts again at page 1 of the new changes.
 */
export async function readHostedFiles(
  reads: ForgeReads,
  request: ForgeHostedFilesRequest,
  preview: Preview,
): Promise<HostedFilesReply> {
  let detail = await prDetail(reads, request);
  const view = hostedView(detail);
  const shownHead = request.headSha?.toLowerCase();
  let moved = shownHead !== undefined && shownHead !== detail.status.headSha.toLowerCase();
  let page = moved ? 1 : request.page;
  const base = { type: "forge.pull.hosted-files" as const, nextPage: null, truncated: null };
  if (view.filesUnavailable)
    return {
      ...base,
      headSha: detail.status.headSha,
      page: 1,
      moved,
      files: [],
      unavailable: view.filesUnavailable,
    };
  let value: ForgePrFiles;
  try {
    value = await filesAt(reads, request, detail, page);
  } catch (error) {
    if (!(error instanceof ForgeRefusal) || error.code !== "forge_head_moved") throw error;
    detail = await prDetail(reads, request);
    moved = true;
    page = 1;
    value = await filesAt(reads, request, detail, page);
  }
  return {
    ...base,
    headSha: detail.status.headSha,
    page,
    moved,
    files: value.files.map((file) => ({
      path: preview(file.path, 4_096),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    nextPage: value.nextPage ?? null,
    truncated: value.truncated
      ? `Some changes are omitted. Open the ${view.noun} on ${view.provider} to see the full diff.`
      : null,
    unavailable: null,
  };
}
