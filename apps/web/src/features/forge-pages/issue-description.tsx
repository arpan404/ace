import { useState } from "react";
import type { ForgeIssueDetail } from "@ace/protocol";
import { ForgeProse, useTaskSave } from "@/features/forge/index.ts";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { IssueWrites } from "./issue-writes.ts";

/**
 * The issue's description under a hairline, edited in place. Saves carry the text they started
 * from, so only someone else's change to the description itself stops one.
 */
export function IssueDescription(props: { issue: ForgeIssueDetail; writes: IssueWrites }) {
  const { issue, writes } = props;
  const [draft, setDraft] = useState<{ base: string; text: string } | undefined>(undefined);
  const save = (body: string, base: string) =>
    writes.write({
      action: "edit",
      number: issue.ref.number,
      expectedUpdatedAt: issue.updatedAt,
      title: issue.title,
      body,
      base: { title: issue.title, body: base },
    });
  // Ticking a task box edits the body, from the text on screen.
  const tasks = useTaskSave(
    issue.permissions.edit
      ? (body: string) => save(body, issue.body).then((written) => written !== undefined)
      : undefined,
    `${issue.ref.number}:${issue.updatedAt}`,
  );
  return (
    <section aria-labelledby="issue-description" className="mt-6 border-t border-border pt-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 id="issue-description" className="text-ui font-medium text-muted-foreground">
          Description
        </h3>
        {issue.permissions.edit && !draft && (
          <Button
            size="xs"
            variant="ghost"
            aria-label="Edit description"
            className="text-muted-foreground"
            onClick={() => setDraft({ base: issue.body, text: issue.body })}
          >
            Edit
          </Button>
        )}
      </div>
      {draft && issue.body !== draft.base && (
        <p role="status" className="mb-2 text-ui text-muted-foreground">
          Someone else changed the description since you started. Saving replaces their text.
        </p>
      )}
      {draft ? (
        <form
          aria-label="Edit description"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.text === issue.body) return setDraft(undefined);
            // From the text on screen: once the note above has said it changed, saving
            // replaces it. A refused save keeps the text, to try again.
            void save(draft.text, issue.body).then((saved) => saved && setDraft(undefined));
          }}
        >
          <MarkdownEditor
            label="Description"
            placeholder="Describe the issue"
            maxLength={64_000}
            value={draft.text}
            onChange={(text) => setDraft({ ...draft, text })}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={writes.pending}>
              Save
            </Button>
          </div>
        </form>
      ) : issue.body.trim() ? (
        <ForgeProse text={issue.body} tasks={tasks} className="text-ui" />
      ) : (
        <p className="text-ui text-subtle-foreground">No description.</p>
      )}
    </section>
  );
}
