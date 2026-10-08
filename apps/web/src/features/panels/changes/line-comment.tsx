import { CheckCircleIcon, CheckIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import type { ReviewDraft } from "./drafts.ts";
import { readReplies, reply } from "./review-actions.ts";

const card =
  "mx-2.5 my-1 rounded-md bg-popover px-2.5 py-2 font-sans text-sm leading-[1.45] whitespace-normal shadow-[0_0_0_1px_var(--border)]";
const box =
  "block w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground";
/** A suggestion's lines, as they would read: the diff's added-line look. */
const suggested = "mt-1.5 rounded-md bg-diff-add px-2.5 py-1 font-mono whitespace-pre-wrap";

/** "line 4", "lines 4–9", "old line 4". */
export function linesLabel(side: "old" | "new", start: number, end = start) {
  return `${side === "old" ? "old " : ""}${end > start ? `lines ${start}–${end}` : `line ${start}`}`;
}

/**
 * Write or edit a comment on one line or a range. On new lines whose text is known it can
 * suggest what they should read instead. ⌘↵ saves, Esc cancels.
 */
export function CommentComposer(props: {
  label: string;
  initial?: string;
  initialSuggestion?: string | undefined;
  /** The selected lines' current text; a suggestion starts from it. Absent: no suggestion. */
  suggestFrom?: string | undefined;
  onSave(text: string, suggestion: string | undefined): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const [suggestion, setSuggestion] = useState(props.initialSuggestion);
  const save = () => {
    if (text.trim()) props.onSave(text.trim(), suggestion);
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
        className={box}
      />
      {suggestion !== undefined && (
        <textarea
          aria-label="Suggested change"
          rows={Math.min(8, suggestion.split("\n").length)}
          value={suggestion}
          onChange={(event) => setSuggestion(event.target.value)}
          onKeyDown={onKeyDown}
          className={cn(box, suggested)}
        />
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={save}>
          Comment
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        {props.suggestFrom !== undefined && (
          <IconButton
            icon={PencilSimpleIcon}
            label={suggestion === undefined ? "Suggest change" : "Remove the suggestion"}
            size="sm"
            pressed={suggestion !== undefined}
            className="ml-auto size-7"
            onClick={() => setSuggestion(suggestion === undefined ? props.suggestFrom : undefined)}
          />
        )}
      </div>
    </div>
  );
}

const anchorNotes: Record<NonNullable<ReviewDraft["anchor"]>, string> = {
  active: "Waiting for the agent",
  "addressed-pending-review": "The agent changed these lines · review and resolve",
  outdated: "Outdated: these lines have changed since",
};

/**
 * A saved comment under its lines, through its life: draft, sending, sent, resolved. A
 * suggestion shows what the lines would read, with Apply; a recorded comment has its replies.
 */
export function DraftCard(props: {
  draft: ReviewDraft;
  onSend(): void;
  onEdit(): void;
  onDiscard(): void;
  onResolve(resolved: boolean): void;
  onApply(): void;
}) {
  const now = useNow();
  const { draft } = props;
  const age = formatAge(draft.createdAt, Math.max(now, draft.createdAt));
  const range = linesLabel(draft.side, draft.line, draft.end);
  const label = `Comment on ${range}`;
  if (draft.state === "resolved")
    return (
      <article
        aria-label={label}
        className={cn(card, "flex items-center gap-2 py-1.5 text-muted-foreground")}
      >
        <CheckCircleIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        <span className="shrink-0 font-medium text-foreground">
          {draft.applied ? "Applied" : "Resolved"}
        </span>
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
        {draft.end !== undefined && draft.end > draft.line && ` · ${range}`}
        {(draft.state === "draft" || draft.state === "failed") && " · not sent yet"}
      </div>
      <p className="text-foreground">
        <InlineMarkdown text={draft.text} />
      </p>
      {draft.suggestion !== undefined && (
        <pre aria-label="Suggested change" className={suggested}>
          {draft.suggestion || " "}
        </pre>
      )}
      {draft.state === "sent" || draft.state === "resolving" ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <CheckIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Sent to agent</span>
          <span className="min-w-0 flex-1 truncate text-subtle-foreground">
            · {anchorNotes[draft.anchor ?? "active"]}
          </span>
          {draft.suggestion !== undefined && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={props.onApply}>
              Apply
            </Button>
          )}
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
          {draft.suggestion !== undefined && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={props.onApply}>
              Apply
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onDiscard}>
            Discard
          </Button>
        </div>
      )}
      {draft.error && (
        <p role="alert" className="mt-1 text-status-failed">
          {draft.state === "failed" ? "Couldn't send. " : "That didn't work. "}
          <InlineMarkdown text={draft.error} />
        </p>
      )}
      {draft.commentId && draft.sessionId && <Replies draft={draft} />}
    </article>
  );
}

/** The replies under a recorded comment, from every device and agent, and a box to add one. */
function Replies(props: { draft: ReviewDraft }) {
  const client = useClient();
  const queries = useQueryClient();
  const { sessionId = "", commentId = "" } = props.draft;
  const key = ["review-replies", sessionId, commentId];
  const replies = useDaemonQuery({
    queryKey: key,
    staleTime: 30_000,
    retry: false,
    read: (daemon) => readReplies(daemon, sessionId, commentId),
  });
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const send = () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    reply(client, props.draft, body).then(
      async () => {
        setText("");
        setError(undefined);
        setSending(false);
        await queries.invalidateQueries({ queryKey: key });
      },
      (failure: unknown) => {
        setSending(false);
        setError(failure instanceof Error ? failure.message : "That didn't work.");
      },
    );
  };
  return (
    <>
      {replies.data?.length ? (
        <ul aria-label="Replies" className="mt-1.5 border-t pt-1">
          {replies.data.map((each) => (
            <li key={each.id} className="text-foreground">
              <InlineMarkdown text={each.text} />
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        aria-label="Reply"
        placeholder="Reply…"
        value={text}
        maxLength={4096}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
        className="mt-1.5 h-7 text-sm"
      />
      {error && (
        <p role="alert" className="mt-1 text-status-failed">
          <InlineMarkdown text={error} />
        </p>
      )}
    </>
  );
}
