/*
 * What "Fix with agent" asks about one review comment or suggestion: the words every client puts
 * in the composer of the thread working on the pull request, for the person to read over and send.
 */

const quoted = (body: string) => `> ${body.split("\n").join("\n> ")}`;

/** What "Fix with agent" asks about one comment from its ⋯ menu. */
export function commentFixRequest(
  comment: { author: string; body: string; file?: string | null; line?: number | null },
  pr: { number: number; url: string },
): string {
  const where = comment.file
    ? ` on ${comment.file}${comment.line === null || comment.line === undefined ? "" : `:${comment.line}`}`
    : "";
  return `Address ${comment.author}'s comment${where} in PR #${pr.number}:\n\n${quoted(comment.body.trim())}\n\nMake the change, push it, and reply to the comment.`;
}

/**
 * What "Apply with agent" asks for a suggestion GitHub can't commit as it is (outdated, or its
 * lines changed): the suggested lines, fenced so their own backticks can't end the block.
 */
export function suggestionFixRequest(
  comment: { author: string; file?: string | null; line?: number | null },
  suggestion: readonly string[],
  pr: { number: number; url: string },
): string {
  const place = comment.file
    ? `${comment.file}${comment.line ? `:${comment.line}` : ""}`
    : "the PR";
  const longest = Math.max(2, ...suggestion.map((l) => /`+/.exec(l)?.[0].length ?? 0));
  const fence = "`".repeat(longest + 1);
  return `Apply ${comment.author}'s suggested change on ${place} in PR #${pr.number} (${pr.url}). The code may have moved since it was suggested: apply it where it fits now.\n\n${fence}\n${suggestion.join("\n")}\n${fence}\n\nPush the change and reply on the thread.`;
}
