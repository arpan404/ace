import { useState } from "react";
import type { ForgeIssueDetail } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import type { IssueWrites } from "./issue-writes.ts";

/**
 * A comment on the issue, and closing or reopening it, as GitHub's own form offers: with text,
 * Close posts the comment first. Only what the signed-in account may do is offered.
 */
export function IssueComposer(props: { issue: ForgeIssueDetail; writes: IssueWrites }) {
  const { issue, writes } = props;
  const [body, setBody] = useState("");
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
    if (posted) setBody((current) => (current === submitted ? "" : current));
    return posted;
  };
  // The state change goes first: it is checked against the issue as last read, which a comment
  // posted before it would have changed.
  const changeState = async () => {
    const changed = await writes.write({
      action: "state",
      number: issue.ref.number,
      expectedUpdatedAt: issue.updatedAt,
      state: open ? "closed" : "open",
    });
    if (changed && text) await comment();
  };
  return (
    <form
      aria-label="Add a comment"
      className="mt-4 flex flex-col gap-2 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (text) void comment();
      }}
    >
      {can.comment && (
        <Textarea
          aria-label="Comment"
          placeholder="Leave a comment (Markdown)"
          rows={4}
          maxLength={64_000}
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            if (text && !busy) void comment();
          }}
        />
      )}
      <div className="flex justify-end gap-2">
        {canState && (
          <Button type="button" disabled={busy} onClick={() => void changeState()}>
            {open ? (text ? "Close with comment" : "Close issue") : "Reopen issue"}
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
