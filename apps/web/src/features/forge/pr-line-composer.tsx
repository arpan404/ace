import { useRef, useState } from "react";
import { validHostedAnchor } from "@ace/forge/review-anchor";
import type { ForgeReviewAnchor, ForgeReviewDraft } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import type { LineRange } from "@/features/panels/index.ts";
import { PrClampedText } from "./pr-clamped.tsx";
import { PrAvatar } from "./pr-presentation.tsx";
import { linesLabel, suggestionBlock } from "./pr-comment-model.ts";
import { appendTo } from "./pr-quote.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { useEdit, useFocusAsk } from "./pr-ui-store.tsx";

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
 * does the main action; unsent text is kept on this device, one per file, so picking other
 * lines keeps it.
 */
export function PrLineComposer(props: {
  path: string;
  /** GitHub's patch for the file; a comment can only sit on lines it holds. */
  patch: string | null;
  diff: FileDiff;
  range: LineRange;
  headSha: string;
  onClose(): void;
}) {
  const review = usePrReview();
  const { range } = props;
  const prKey = JSON.stringify(review?.detail.status.ref ?? null);
  const draft = useMarkdownDraft(
    review ? `pr:${review.workspaceId}:${prKey}:line:${props.path}` : undefined,
  );
  const [id] = useState(() => crypto.randomUUID());
  const box = useRef<HTMLFormElement>(null);
  useFocusAsk(`line:${props.path}`, box);
  const pending = review?.state?.drafts.length ?? 0;
  const anchor = anchorOf(props.path, range, props.headSha);
  // Lines read from the whole file (an opened fold) aren't in GitHub's patch: it refuses them.
  const placeable = props.patch !== null && validHostedAnchor(props.patch, anchor);
  const disabled = !review?.ready || review.pending || !draft.text.trim() || !placeable;
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
      ref={box}
      aria-label={`Comment on ${linesLabel(range.side, range.start, range.end)}`}
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          // Esc puts the comment away; its text waits for lines of this file to be picked again.
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <p className="text-xs text-subtle-foreground">
        {`Commenting on ${linesLabel(range.side, range.start, range.end)}`}
      </p>
      {!placeable && (
        <p role="status" className="text-xs text-muted-foreground">
          {props.patch === null
            ? "GitHub didn't send this file's changes, so it can't take a comment on its lines."
            : "GitHub takes comments only on lines in its diff. Pick lines inside one change."}
        </p>
      )}
      <MarkdownEditor
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
            disabled={!placeable}
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
  const [stored, setStored, clearIf] = useEdit(`draft:${draft.id}`);
  const edit = stored?.body;
  const setEdit = (body: string | undefined) =>
    setStored(body === undefined ? undefined : { body, expectedBody: draft.body });
  const box = useRef<HTMLDivElement>(null);
  const askFocus = useFocusAsk(`edit:draft:${draft.id}`, box);
  const [open, setOpen] = useState(false);
  const disabled = !review?.ready || review.pending;
  const save = () => {
    if (!stored || !stored.body.trim() || disabled || !review) return;
    const sent = stored;
    void review
      .run({ kind: "draft.save", draft: { ...draft, body: sent.body } })
      // Text changed while it saved stays open to save again.
      .then((ok) => ok && clearIf(sent));
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="flex min-h-6 items-center gap-1.5 text-ui text-muted-foreground">
        <PrAvatar name={review?.state?.viewer ?? ""} />
        <span className="font-medium text-foreground">{review?.state?.viewer}</span>
        <span className="text-xs text-status-needs-you">Pending</span>
        <span className="ml-auto flex gap-1">
          {edit === undefined && (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setEdit(draft.body);
                askFocus();
              }}
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
        <div className="pl-[26px]">
          <PrClampedText text={draft.body} open={open} onToggle={() => setOpen(!open)} />
        </div>
      ) : (
        <div ref={box} className="space-y-2 pl-[26px]">
          <MarkdownEditor
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
