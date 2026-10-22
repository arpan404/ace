import { issueQuery } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { draftKeys, useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { WorkHeading } from "@/components/work-heading.tsx";
import { Screen } from "@/features/shell/index.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { useBackToList } from "./back-to-list.ts";
import { readable } from "./issue-page.tsx";
import { useIssueWrites } from "./issue-writes.ts";
import { useIssuePages } from "./lists.ts";
import { useProjectChoice } from "./project-choice.ts";

/**
 * A new issue as a page in the main column, laid out as the issue it becomes: back to the
 * list, the title in large type, the description in the Markdown editor, then Create. What is
 * written stays as a draft on this device until the issue is created. Created, its page opens
 * in this one's place.
 */
export function NewIssuePage(props: {
  project: string;
  /** The list's own address, when opened from it. */
  back: string | undefined;
}) {
  const { project } = props;
  const choice = useProjectChoice(project);
  const back = useBackToList("/issues", project, props.back);
  // The list's first page names the repository and whether this account may open issues.
  const list = useIssuePages(project, issueQuery({}, 1), 1);
  const writes = useIssueWrites(project, list.first?.repository);
  const title = useMarkdownDraft(draftKeys.newIssueTitle(project));
  const body = useMarkdownDraft(draftKeys.newIssue(project));
  const navigate = useNavigate();
  const ready = !!title.text.trim() && writes.ready && !writes.pending;
  const create = async () => {
    if (!ready) return;
    const issue = await writes.write({
      action: "create",
      title: title.text.trim(),
      body: body.text,
    });
    if (!issue) return;
    title.clear();
    body.clear();
    void navigate({
      to: "/issues/$project/$number",
      params: { project, number: String(issue.number) },
      search: { back: props.back },
      replace: true,
    });
  };
  const closed = list.first && !list.first.canCreate;
  return (
    <Screen title="New issue" crumb={choice.name(project)}>
      <article aria-label="New issue" className="h-full overflow-y-auto">
        <form
          className={`${readable} pt-6 pb-16`}
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <WorkHeading
            back={{ label: "Issues", onBack: back }}
            title={
              <input
                aria-label="Title"
                placeholder="Title"
                maxLength={256}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the page exists to write this.
                autoFocus
                value={title.text}
                onChange={(event) => title.setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  const mod = applePlatform ? event.metaKey : event.ctrlKey;
                  if (event.key !== "Enter") return;
                  // Enter in the title moves on to the description; ⌘↵ creates.
                  event.preventDefault();
                  if (mod) event.currentTarget.form?.requestSubmit();
                  else
                    event.currentTarget.form
                      ?.querySelector<HTMLTextAreaElement>("textarea")
                      ?.focus();
                }}
                className="h-9 w-full min-w-0 bg-transparent text-xl font-semibold tracking-title text-foreground placeholder:font-normal focus:outline-none placeholder:text-subtle-foreground"
              />
            }
          />
          {closed ? (
            <EmptyState
              variant="inline"
              title="Can't open issues here"
              description={`GitHub doesn't let this account open issues in ${list.first?.repository.name ?? "this repository"}.`}
            />
          ) : (
            <>
              <MarkdownEditor
                className="mt-4"
                size="page"
                label="Description"
                placeholder="Add a description"
                maxLength={64_000}
                value={body.text}
                onChange={body.setText}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={back}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={!ready}>
                  Create issue
                  <Kbd aria-hidden variant="on-primary" resolve={false} keys="mod+enter" />
                </Button>
              </div>
            </>
          )}
        </form>
      </article>
    </Screen>
  );
}
