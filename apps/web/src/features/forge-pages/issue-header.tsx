import { useState } from "react";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  DotsThreeIcon,
  ProhibitIcon,
  RecordIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { ForgeIssueDetail } from "@ace/protocol";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { RelativeTime } from "@/components/person-avatar.tsx";
import { WorkHeading, WorkTitle } from "@/components/work-heading.tsx";
import type { IssueWrites } from "./issue-writes.ts";

/** An issue's state as words in its tone: "Open", "Closed as completed", "Closed as not planned". */
export function IssueState(props: { issue: ForgeIssueDetail }) {
  const { issue } = props;
  const notPlanned = issue.state === "closed" && issue.stateReason === "not_planned";
  const [tone, Glyph, words] =
    issue.state === "open"
      ? (["done", RecordIcon, "Open"] as const)
      : notPlanned
        ? (["idle", ProhibitIcon, "Closed as not planned"] as const)
        : (["waiting", CheckCircleIcon, "Closed as completed"] as const);
  return (
    <span
      data-tone={tone}
      className="inline-flex shrink-0 items-center gap-1 font-medium text-(--tone-text)"
    >
      <Glyph aria-hidden size={14} />
      {words}
    </span>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The title, or its editor in place; Enter saves, Escape puts it back. */
function Title(props: { issue: ForgeIssueDetail; writes: IssueWrites }) {
  const { issue, writes } = props;
  const [draft, setDraft] = useState<{ base: string; text: string } | undefined>(undefined);
  if (draft === undefined)
    return (
      <WorkTitle
        text={issue.title}
        number={issue.ref.number}
        trailing={
          issue.permissions.edit ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label="Edit title"
              className="mt-0.5 shrink-0 text-muted-foreground"
              onClick={() => setDraft({ base: issue.title, text: issue.title })}
            >
              Edit
            </Button>
          ) : undefined
        }
      />
    );
  const text = draft.text.trim();
  // Someone retitled it while this was open: the note says so, and saving replaces theirs.
  const moved = issue.title !== draft.base;
  const save = async () => {
    if (!text || text === issue.title) return setDraft(undefined);
    const saved = await writes.write({
      action: "edit",
      number: issue.ref.number,
      expectedUpdatedAt: issue.updatedAt,
      title: text,
      body: issue.body,
      base: { title: issue.title, body: issue.body },
    });
    // A refused save keeps the text, to try again.
    if (saved) setDraft(undefined);
  };
  return (
    <form
      aria-label="Edit title"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        autoFocus
        aria-label="Title"
        maxLength={256}
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(undefined);
          }
        }}
        className="min-w-0 flex-1 text-lg font-semibold"
      />
      <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" size="sm" disabled={!text || writes.pending}>
        Save
      </Button>
      {moved && (
        <p role="status" className="w-full text-ui text-muted-foreground">
          Now titled “{issue.title}” on GitHub. Saving replaces it.
        </p>
      )}
    </form>
  );
}

/**
 * The top of an issue's page: back, the title (editable in place), its state in words and who
 * opened it, then a line of facts: comments, linked agent threads, last change.
 */
export function IssueHeader(props: {
  project: string;
  issue: ForgeIssueDetail;
  writes: IssueWrites;
  backLabel: string;
  onBack(): void;
}) {
  const { issue } = props;
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const navigate = useNavigate();
  const threads = issue.relatedThreads.filter((thread) => !thread.archived).length;
  return (
    <header>
      <WorkHeading
        back={{ label: props.backLabel, onBack: props.onBack }}
        title={<Title issue={issue} writes={props.writes} />}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void navigate({ to: "/new", search: { project: props.project, issue: issue.url } })
              }
            >
              New thread
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Issue actions"
                    className="size-6 px-0"
                  />
                }
              >
                <DotsThreeIcon aria-hidden size={16} />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  icon={<ArrowSquareOutIcon aria-hidden size={16} />}
                  onClick={() =>
                    void openWeb(issue.url).catch(() =>
                      toast.error({ title: "Couldn't open GitHub" }),
                    )
                  }
                >
                  Open on GitHub
                </MenuItem>
                <MenuItem
                  icon={<CopyIcon aria-hidden size={16} />}
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(issue.url)
                      .catch(() => toast.error({ title: "Couldn't copy the link" }))
                  }
                >
                  Copy link
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
        badge={<IssueState issue={issue} />}
        byline={
          <>
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
            <span className="text-foreground/85">{issue.author}</span>
            <span>opened this</span>
            <RelativeTime at={issue.createdAt} />
          </>
        }
      />
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-ui text-muted-foreground">
        {issue.commentCount !== undefined && <span>{plural(issue.commentCount, "comment")}</span>}
        {threads > 0 && <span>{plural(threads, "agent thread")}</span>}
        <span className="inline-flex items-center gap-1">
          Updated <RelativeTime at={issue.updatedAt} />
        </span>
      </p>
    </header>
  );
}
