import type { ForgeIssueDetail } from "@ace/protocol";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { draftKeys, useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import type { IssueWrites } from "./issue-writes.ts";

/**
 * A comment on the issue, and closing (as completed or as not planned) or reopening it: with
 * text, the comment posts after the state changes. Only what the signed-in account may do is offered. Unsent text
 * stays as a draft on this device.
 */
export function IssueComposer(props: {
  project: string;
  issue: ForgeIssueDetail;
  writes: IssueWrites;
}) {
  const { issue, writes } = props;
  const draft = useMarkdownDraft(draftKeys.issueComment(props.project, issue.ref.number));
  const body = draft.text;
  const can = issue.permissions;
  const open = issue.state === "open";
  const canState = open ? can.close : can.reopen;
  if (!can.comment && !canState) return null;
  const busy = !writes.ready || writes.pending;
  const text = body.trim();
  const comment = async () => {
    const submitted = body;
    const posted = await writes.write({
      action: "comment",
      number: issue.ref.number,
      body: submitted,
    });
    // Text typed while it posted stays.
    if (posted) draft.clear(submitted);
    return posted;
  };
  const changeState = async (reason?: "completed" | "not_planned") => {
    const changed = await writes.write({
      action: "state",
      number: issue.ref.number,
      expectedUpdatedAt: issue.updatedAt,
      state: open ? "closed" : "open",
      ...(reason ? { reason } : {}),
    });
    if (changed && text) await comment();
  };
  return (
    <form
      aria-label="Add a comment"
      className="mt-4 flex flex-col gap-2 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (text && !busy) void comment();
      }}
    >
      {can.comment && (
        <MarkdownEditor
          label="Comment"
          placeholder="Leave a comment"
          maxLength={64_000}
          value={body}
          onChange={draft.setText}
        />
      )}
      <div className="flex justify-end gap-2">
        {canState && open && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void changeState("not_planned")}
          >
            Close as not planned
          </Button>
        )}
        {canState && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void changeState(open ? "completed" : undefined)}
          >
            {open
              ? text
                ? "Close with comment"
                : "Close as completed"
              : text
                ? "Reopen with comment"
                : "Reopen issue"}
          </Button>
        )}
        {can.comment && (
          <Button type="submit" variant="primary" disabled={busy || !text}>
            Comment
          </Button>
        )}
      </div>
    </form>
  );
}
