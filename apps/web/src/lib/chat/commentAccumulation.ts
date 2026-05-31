import type { QueuedComposerImageAttachment } from "../../types";

export interface PendingComposerComment {
  readonly id: string;
  readonly source: "browser" | "review";
  readonly body: string;
  readonly targetLabel: string;
  readonly detailLabel: string | null;
  readonly hiddenContextBlock: string;
  readonly image?: QueuedComposerImageAttachment;
  readonly createdAt: string;
}

function formatCommentHeader(comment: PendingComposerComment, index: number): string {
  const sourceLabel = comment.source === "review" ? "Review comment" : "Browser comment";
  const parts = [`${index + 1}. ${sourceLabel}`];
  if (comment.targetLabel.trim().length > 0) {
    parts.push(`Target: ${comment.targetLabel.trim()}`);
  }
  if (comment.detailLabel?.trim()) {
    parts.push(
      `${comment.source === "review" ? "Scope" : "Element"}: ${comment.detailLabel.trim()}`,
    );
  }
  if (comment.image) {
    parts.push(`Screenshot: attached image ${index + 1}`);
  }
  return parts.join("\n");
}

export function buildAccumulatedCommentsPrompt(
  basePrompt: string,
  comments: ReadonlyArray<PendingComposerComment>,
): string {
  const trimmedBasePrompt = basePrompt.trim();
  if (comments.length === 0) {
    return trimmedBasePrompt;
  }
  const commentBlock = [
    "<accumulated_comments>",
    "Apply these user comments with the attached screenshots.",
    ...comments.map((comment, index) =>
      [formatCommentHeader(comment, index), `Comment: ${comment.body.trim()}`].join("\n"),
    ),
    "</accumulated_comments>",
  ].join("\n\n");
  const hiddenContextBlocksParts: string[] = [];
  for (const comment of comments) {
    const hiddenContextBlock = comment.hiddenContextBlock.trim();
    if (hiddenContextBlock.length > 0) {
      hiddenContextBlocksParts.push(hiddenContextBlock);
    }
  }
  const hiddenContextBlocks = hiddenContextBlocksParts.join("\n\n");
  return [trimmedBasePrompt, commentBlock, hiddenContextBlocks]
    .filter((value) => value.length > 0)
    .join("\n\n");
}

export function mergePendingCommentImages<TImage extends { readonly id: string }>(
  images: ReadonlyArray<TImage>,
  comments: ReadonlyArray<PendingComposerComment>,
): Array<QueuedComposerImageAttachment | TImage> {
  const seenImageIds = new Set<string>();
  const commentImages = comments.flatMap((comment) => (comment.image ? [comment.image] : []));
  return [...commentImages, ...images].filter((image) => {
    if (seenImageIds.has(image.id)) {
      return false;
    }
    seenImageIds.add(image.id);
    return true;
  });
}
