import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type GitHubIssueThread } from "@ace/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { gitGitHubIssueThreadQueryOptions } from "~/lib/gitReactQuery";

import { fetchGitHubIssueMarkdownImages } from "./githubIssueImages";
import {
  buildGitHubIssueHiddenContextFromThreads,
  buildGitHubIssuePromptFromThreads,
} from "./githubIssuePrompt";

function normalizeIssueNumbers(issueNumbers: ReadonlyArray<number>): number[] {
  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const issueNumber of issueNumbers) {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || seen.has(issueNumber)) {
      continue;
    }
    seen.add(issueNumber);
    normalized.push(issueNumber);
  }
  return normalized;
}

export async function buildGitHubIssueSelectionPayload(input: {
  cwd: string;
  issueNumbers: ReadonlyArray<number>;
  queryClient: QueryClient;
  includeSummaryLines?: boolean;
}): Promise<{
  issueNumbers: number[];
  threads: GitHubIssueThread[];
  prompt: string;
  images: ComposerImageAttachment[];
}> {
  const issueNumbers = normalizeIssueNumbers(input.issueNumbers);
  if (issueNumbers.length === 0) {
    throw new Error("Select at least one GitHub issue.");
  }

  const threadResults = await Promise.all(
    issueNumbers.map((issueNumber) =>
      input.queryClient.fetchQuery(
        gitGitHubIssueThreadQueryOptions({
          cwd: input.cwd,
          issueNumber,
          enabled: true,
        }),
      ),
    ),
  );
  const threads = threadResults.map((result) => result.issue);
  const prompt =
    input.includeSummaryLines === false
      ? buildGitHubIssueHiddenContextFromThreads(threads)
      : buildGitHubIssuePromptFromThreads(threads);

  const issueImages = await Promise.all(
    threads.map((thread) => fetchGitHubIssueMarkdownImages(thread)),
  );
  const allImages = issueImages.flat();
  if (allImages.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const overflowImage of allImages.slice(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)) {
        URL.revokeObjectURL(overflowImage.previewUrl);
      }
    }
  }

  return {
    issueNumbers,
    threads,
    prompt,
    images: allImages.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  };
}
