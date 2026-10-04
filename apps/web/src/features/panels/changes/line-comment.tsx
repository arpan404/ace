import { CheckCircleIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import type { ReviewDraft } from "./drafts.ts";

const card =
  "my-1 mr-3 ml-14 rounded-md bg-popover px-2.5 py-2 font-sans text-sm leading-[1.45] whitespace-normal shadow-[0_0_0_1px_var(--border)]";

/** Write or edit a comment on one line. ⌘↵ saves, Esc cancels. */
export function CommentComposer(props: {
  label: string;
  initial?: string;
  onSave(text: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const save = () => {
    if (text.trim()) props.onSave(text.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    }
  };
  return (
    <div className={card}>
      <textarea
        aria-label={props.label}
        // A composer opens because the person just asked to write; focus belongs in it.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        rows={2}
        value={text}
        placeholder="Leave a comment for the agent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="block w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground"
      />
      <div className="mt-1.5 flex gap-1.5">
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={save}>
          Comment
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const anchorNotes: Record<NonNullable<ReviewDraft["anchor"]>, string> = {
  active: "Waiting for the agent",
  "addressed-pending-review": "The agent changed these lines · review and resolve",
  outdated: "Outdated: these lines have changed since",
};

/** A saved comment under its line, through its life: draft, sending, sent, resolved. */
export function DraftCard(props: {
  draft: ReviewDraft;
  onSend(): void;
  onEdit(): void;
  onDiscard(): void;
  onResolve(resolved: boolean): void;
}) {
  const now = useNow();
  const { draft } = props;
  const age = formatAge(draft.createdAt, Math.max(now, draft.createdAt));
  const label = `Comment on ${draft.side === "old" ? "old " : ""}line ${draft.line}`;
  if (draft.state === "resolved")
    return (
      <article
        aria-label={label}
        className={cn(card, "flex items-center gap-2 py-1.5 text-muted-foreground")}
      >
        <CheckCircleIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        <span className="shrink-0 font-medium text-foreground">Resolved</span>
        <span className="min-w-0 flex-1 truncate">{draft.text}</span>
        <Button size="sm" variant="ghost" onClick={() => props.onResolve(false)}>
          Reopen
        </Button>
      </article>
    );
  const busy = draft.state === "sending" || draft.state === "resolving";
  return (
    <article aria-label={label} className={card}>
      <div className="text-subtle-foreground">
        <b className="font-medium text-foreground">You</b> ·{" "}
        {age === "now" ? "just now" : `${age} ago`}
        {(draft.state === "draft" || draft.state === "failed") && " · not sent yet"}
      </div>
      <p className="text-foreground">
        <InlineMarkdown text={draft.text} />
      </p>
      {draft.state === "sent" || draft.state === "resolving" ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <CheckIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Sent to agent</span>
          <span className="min-w-0 flex-1 truncate text-subtle-foreground">
            · {anchorNotes[draft.anchor ?? "active"]}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onResolve(true)}>
            {draft.state === "resolving" ? "Resolving…" : "Resolve"}
          </Button>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button size="sm" variant="primary" disabled={busy} onClick={props.onSend}>
            {draft.state === "sending"
              ? "Sending…"
              : draft.state === "failed"
                ? "Retry"
                : "Send to agent"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onDiscard}>
            Discard
          </Button>
        </div>
      )}
      {draft.error && (draft.state === "failed" || draft.state === "sent") && (
        <p role="alert" className="mt-1 text-status-failed">
          {draft.state === "failed" ? "Couldn't send" : "Couldn't resolve"}: {draft.error}
        </p>
      )}
    </article>
  );
}
