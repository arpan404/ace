import { useState } from "react";
import type { ForgeReviewAnchor, ForgeReviewDraft } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import type { LineRange } from "@/features/panels/index.ts";
import { PrClampedText } from "./pr-clamped.tsx";
import { linesLabel, suggestionBlock } from "./pr-comment-model.ts";
import { appendTo } from "./pr-quote.tsx";
import { usePrReview } from "./pr-review-context.tsx";

/** The review anchor for `range` of `path` at `headSha`. */
export function anchorOf(path: string, range: LineRange, headSha: string): ForgeReviewAnchor {
  const side = range.side === "old" ? "LEFT" : "RIGHT";
  return {
    commit: headSha,
    path,
    line: range.end,
    side,
    ...(range.start < range.end ? { startLine: range.start, startSide: side } : {}),
  };
}

/**
 * A new comment under the lines it is about. With no review started it posts on its own (Add
 * single comment) or starts one (Start a review); once comments are pending it joins them (Add
 * review comment). Suggest changes starts a suggestion from the lines as they read now. ⌘↵
 * does the main action; unsent text is kept on this device per line range.
 */
export function PrLineComposer(props: {
  path: string;
  diff: FileDiff;
  range: LineRange;
  headSha: string;
  onClose(): void;
}) {
  const review = usePrReview();
  const { range } = props;
  const prKey = JSON.stringify(review?.detail.status.ref ?? null);
  const draft = useMarkdownDraft(
    review
      ? `pr:${review.workspaceId}:${prKey}:line:${props.path}:${range.side}:${range.start}-${range.end}`
      : undefined,
  );
  const [id] = useState(() => crypto.randomUUID());
  const pending = review?.state?.drafts.length ?? 0;
  const disabled = !review?.ready || review.pending || !draft.text.trim();
  const anchor = anchorOf(props.path, range, props.headSha);
  const done = (body: string) => (ok: boolean) => {
    if (ok && draft.clear(body)) props.onClose();
  };
  const single = () => {
    const body = draft.text;
    if (disabled || !review) return;
    void review
      .run({ kind: "line.comment", headSha: props.headSha, anchor, body })
      .then(done(body));
  };
  const save = () => {
    const body = draft.text;
    if (disabled || !review) return;
    void review.run({ kind: "draft.save", draft: { id, anchor, body } }).then(done(body));
  };
  const cancel = () => {
    draft.clear();
    props.onClose();
  };
  return (
    <form
      aria-label={`Comment on ${linesLabel(range.side, range.start, range.end)}`}
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          // Esc puts the comment away; its text waits for these lines to be picked again.
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <p className="text-xs text-subtle-foreground">
        {`Commenting on ${linesLabel(range.side, range.start, range.end)}`}
      </p>
      <MarkdownEditor
        autoFocus
        label="Line comment"
        placeholder="Leave a comment"
        maxLength={60_000}
        value={draft.text}
        onChange={draft.setText}
        onSubmit={save}
      />
      <div className="flex flex-wrap items-center gap-2">
        {range.side === "new" && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              draft.setText(
                appendTo(draft.text, suggestionBlock(props.diff.rows, range.start, range.end)),
              )
            }
          >
            Suggest changes
          </Button>
        )}
        <span className="ml-auto flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          {pending === 0 && (
            <Button type="button" variant="secondary" disabled={disabled} onClick={single}>
              Add single comment
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={disabled}>
            {pending === 0 ? "Start a review" : "Add review comment"}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** A comment waiting in the viewer's review, under its line: its text, Edit and Remove. */
export function PrPendingComment(props: { draft: ForgeReviewDraft }) {
  const review = usePrReview();
  const { draft } = props;
  const [edit, setEdit] = useState<string>();
  const [open, setOpen] = useState(false);
  const disabled = !review?.ready || review.pending;
  const save = () => {
    if (edit === undefined || !edit.trim() || disabled || !review) return;
    const body = edit;
    void review
      .run({ kind: "draft.save", draft: { ...draft, body } })
      .then((ok) => ok && setEdit((current) => (current === body ? undefined : current)));
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="flex items-center gap-1.5 text-ui text-muted-foreground">
        <span className="font-medium text-foreground">{review?.state?.viewer}</span>
        <span className="text-xs text-status-needs-you">Pending</span>
        <span className="ml-auto flex gap-1">
          {edit === undefined && (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => setEdit(draft.body)}
            >
              Edit
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            tone="danger"
            disabled={disabled}
            onClick={() => void review?.run({ kind: "draft.delete", id: draft.id })}
          >
            Remove
          </Button>
        </span>
      </p>
      {edit === undefined ? (
        <PrClampedText text={draft.body} open={open} onToggle={() => setOpen(!open)} />
      ) : (
        <div className="space-y-2">
          <MarkdownEditor
            autoFocus
            label="Edit pending comment"
            maxLength={60_000}
            value={edit}
            onChange={setEdit}
            onSubmit={save}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEdit(undefined)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={disabled || !edit.trim()} onClick={save}>
              Update comment
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
