import type { ForgeBrowserOperation, ForgeBrowserResult } from "@ace/protocol";
import type { TeaReader } from "@ace/forge";

/** Extra tea PR reads stay out of the generic and GitHub routing; issues go through hosted-issues. */
export async function teaForgeBrowse(
  reader: TeaReader,
  operation: ForgeBrowserOperation,
  signal: AbortSignal,
): Promise<ForgeBrowserResult | undefined> {
  if (operation.op === "forge.pr.reviewers")
    return {
      resource: "prReviewers",
      value: await reader.reviews.reviewers(operation.number, signal),
    };
  if (operation.op === "forge.pr.commits")
    return {
      resource: "prCommits",
      ...(await reader.prCommits(operation.number, operation.before, operation.headSha, signal)),
    };
  return undefined;
}
