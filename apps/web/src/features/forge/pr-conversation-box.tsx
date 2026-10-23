import { useRef } from "react";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { draftKeys, useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import { PrAvatar } from "./pr-presentation.tsx";
import { appendTo, useQuotedInto } from "./pr-quote.tsx";
import { lockedText, usePrDetail, usePrIdentity, usePrReview } from "./pr-review-context.tsx";
import { useFocusAsk } from "./pr-ui-store.tsx";

/** The viewer's avatar, borrowed from anything they wrote here (ace never asks GitHub for it). */
function useViewerAvatar(viewer: string | undefined): string | undefined {
  const detail = usePrDetail();
  if (!viewer || !detail) return undefined;
  if (detail.author === viewer && detail.authorAvatarUrl) return detail.authorAvatarUrl;
  return detail.status.comments.find((c) => c.author === viewer && c.authorAvatarUrl)
    ?.authorAvatarUrl;
}

/**
 * The comment box at the Timeline's newest end: the viewer's avatar beside the Markdown editor,
 * and Comment (⌘↵). Unsent text is kept on this device; a quote reply lands here.
 */
export function PrConversationBox() {
  const review = usePrReview();
  const box = useRef<HTMLDivElement>(null);
  const identity = usePrIdentity();
  const draft = useMarkdownDraft(
    identity ? draftKeys.prComment(identity.workspaceId, identity.prKey) : undefined,
  );
  const askFocus = useFocusAsk("conversation", box);
  useQuotedInto("conversation", (text) => {
    draft.setText(appendTo(draft.text, text));
    askFocus();
  });
  const viewer = review?.state?.viewer;
  const avatar = useViewerAvatar(viewer);
  const locked = !!review?.commentsLocked;
  // A locked conversation keeps the box, off, with GitHub's reason.
  if (!review?.state || (!review.state.canComment && !locked)) return null;
  const disabled = !review.ready || review.pending || locked;
  const send = () => {
    const body = draft.text;
    if (disabled || !body.trim()) return;
    void review.run({ kind: "conversation", body }).then((ok) => {
      if (ok) draft.clear(body);
    });
  };
  return (
    <div ref={box} className="relative flex gap-4 pb-6">
      <div className="relative z-[1] flex size-8 shrink-0 items-start justify-center bg-panel pt-0.5">
        <PrAvatar name={viewer ?? ""} url={avatar} className="size-8" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <MarkdownEditor
          label="Comment"
          placeholder="Leave a comment"
          maxLength={60_000}
          value={draft.text}
          disabled={locked}
          onChange={draft.setText}
          onSubmit={send}
        />
        <div className="flex items-center justify-end gap-2">
          {locked && (
            <p role="status" className="mr-auto text-xs text-muted-foreground">
              {lockedText}
            </p>
          )}
          <Button variant="primary" disabled={disabled || !draft.text.trim()} onClick={send}>
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}
