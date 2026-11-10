import type { ForgeBrowserOperation, ForgeBrowserResult } from "@ace/protocol";
import type { TeaReader } from "@ace/forge";

/** Extra tea reads stay out of the generic and GitHub routing. */
export async function teaForgeBrowse(
  reader: TeaReader,
  operation: ForgeBrowserOperation,
  signal: AbortSignal,
): Promise<ForgeBrowserResult | undefined> {
  if (operation.op === "forge.pr.commits")
    return {
      resource: "prCommits",
      ...(await reader.prCommits(operation.number, operation.before, operation.headSha, signal)),
    };
  if (operation.op === "forge.issue.list")
    return {
      resource: "issueList",
      value: await reader.issues.listIssues(operation.query, signal),
    };
  if (operation.op === "forge.issue.detail")
    return {
      resource: "issueDetail",
      value: await reader.issues.issueDetail(operation.number, signal),
    };
  if (operation.op === "forge.issue.timeline")
    return {
      resource: "issueTimeline",
      ...(await reader.issues.issueTimeline(operation.number, operation.page, signal)),
    };
  return undefined;
}
