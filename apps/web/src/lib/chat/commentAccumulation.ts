import type { QueuedComposerImageAttachment } from "../../types";

export interface PendingComposerComment {
  readonly id: string;
  readonly source: "browser";
  readonly body: string;
  readonly targetLabel: string;
  readonly detailLabel: string | null;
  readonly hiddenContextBlock: string;
  readonly image: QueuedComposerImageAttachment;
  readonly createdAt: string;
}

function formatCommentHeader(comment: PendingComposerComment, index: number): string {
  const parts = [`${index + 1}. Browser comment`];
  if (comment.targetLabel.trim().length > 0) {
    parts.push(`Target: ${comment.targetLabel.trim()}`);
  }
  if (comment.detailLabel?.trim()) {
    parts.push(`Element: ${comment.detailLabel.trim()}`);
  }
  parts.push(`Screenshot: attached image ${index + 1}`);
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
  const hiddenContextBlocks = comments
    .map((comment) => comment.hiddenContextBlock.trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
  return [trimmedBasePrompt, commentBlock, hiddenContextBlocks]
    .filter((value) => value.length > 0)
    .join("\n\n");
}

export function mergePendingCommentImages<TImage extends { readonly id: string }>(
  images: ReadonlyArray<TImage>,
  comments: ReadonlyArray<PendingComposerComment>,
): Array<QueuedComposerImageAttachment | TImage> {
  const seenImageIds = new Set<string>();
  return [...comments.map((comment) => comment.image), ...images].filter((image) => {
    if (seenImageIds.has(image.id)) {
      return false;
    }
    seenImageIds.add(image.id);
    return true;
  });
}
