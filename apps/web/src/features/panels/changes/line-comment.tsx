import { CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import type { ReviewDraft } from "./drafts.ts";

const card =
  "my-1 mr-3 ml-14 rounded-[9px] bg-popover px-2.5 py-2 font-sans text-sm leading-[1.45] whitespace-normal shadow-[0_0_0_1px_var(--border)]";

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

/** A saved comment under its line: draft, sending, sent or failed. */
export function DraftCard(props: {
  draft: ReviewDraft;
  onSend(): void;
  onEdit(): void;
  onDiscard(): void;
}) {
  const now = useNow();
  const { draft } = props;
  const age = formatAge(draft.createdAt, Math.max(now, draft.createdAt));
  return (
    <article aria-label={`Comment on line ${draft.line}`} className={card}>
      <div className="text-subtle-foreground">
        <b className="font-medium text-foreground">You</b> ·{" "}
        {age === "now" ? "just now" : `${age} ago`}
      </div>
      <p className="text-foreground">
        <InlineMarkdown text={draft.text} />
      </p>
      {draft.state === "sent" ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-muted-foreground">
          <CheckIcon aria-hidden size={14} />
          Sent to agent
        </p>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={draft.state === "sending"}
            onClick={props.onSend}
          >
            {draft.state === "sending"
              ? "Sending…"
              : draft.state === "failed"
                ? "Retry"
                : "Send to agent"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={draft.state === "sending"}
            onClick={props.onEdit}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={draft.state === "sending"}
            onClick={props.onDiscard}
          >
            Discard
          </Button>
          {draft.state === "failed" && (
            <span role="alert" className="min-w-0 truncate text-status-failed">
              Couldn't send: {draft.error}
            </span>
          )}
        </div>
      )}
    </article>
  );
}
