import type { ReviewSession } from "@ace/protocol";
import { ArrowClockwiseIcon, CheckCircleIcon, ProhibitIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { isOpen, isPending, type ReviewDraft } from "./drafts.ts";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 to send · 1 waiting for the agent · 3 resolved": where this thread's review stands. */
export function reviewSummary(drafts: readonly ReviewDraft[]): string {
  const pending = drafts.filter(isPending).length;
  const sending = drafts.filter((draft) => draft.state === "sending").length;
  const open = drafts.filter(isOpen).length;
  const resolved = drafts.filter((draft) => draft.state === "resolved").length;
  return [
    pending && `${plural(pending, "comment", "comments")} to send`,
    sending && "sending…",
    open && `${open} waiting for the agent`,
    resolved && `${resolved} resolved`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const groups = [
  {
    label: "To send",
    match: (draft: ReviewDraft) => isPending(draft) || draft.state === "sending",
  },
  { label: "Sent", match: isOpen },
  { label: "Resolved", match: (draft: ReviewDraft) => draft.state === "resolved" },
] as const;

/**
 * The thread's review at a glance, under the toolbar: whether it is approved, how many
 * comments still need sending, how many the agent has, how many are resolved. Approve and
 * Request changes act on the review; Send sends every unsent comment at once; Comments lists
 * them all and jumps to one.
 */
export function ReviewBar(props: {
  drafts: readonly ReviewDraft[];
  session: ReviewSession | undefined;
  onReview(status: "approved" | "changes-requested"): Promise<void>;
  onSend(keys: readonly string[]): void;
  onJump(file: string): void;
  onRefresh(): Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const pending = props.drafts.filter(isPending);
  const status = props.session?.status ?? "open";
  // Changes requested reads from its pressed icon and the comments waiting for the agent.
  const summary =
    [status === "approved" && "Approved", reviewSummary(props.drafts)]
      .filter(Boolean)
      .join(" · ") || "No comments · pick lines to comment on them";
  const act = (next: "approved" | "changes-requested") =>
    void props.onReview(next).then(
      () => setError(undefined),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  return (
    <section
      aria-label="Review"
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-panel pr-2 pl-3.5 text-sm"
    >
      <span role="status" className="min-w-0 flex-1 truncate text-muted-foreground">
        {error ? <span className="text-status-failed">{error}</span> : summary}
      </span>
      {refreshing && <Spinner label="Checking comments" />}
      {/* Comments from other devices and agents, and what became of the ones sent. */}
      <IconButton
        icon={ArrowClockwiseIcon}
        label="Check what ace holds for these comments"
        size="sm"
        className="size-7"
        disabled={refreshing}
        onClick={() => {
          setRefreshing(true);
          void props.onRefresh().finally(() => setRefreshing(false));
        }}
      />
      <IconButton
        icon={CheckCircleIcon}
        label={status === "approved" ? "Approved" : "Approve"}
        size="sm"
        className="size-7"
        pressed={status === "approved"}
        onClick={() => act("approved")}
      />
      <IconButton
        icon={ProhibitIcon}
        label={
          pending.length ? "Request changes: send the comments to the agent" : "Request changes"
        }
        size="sm"
        className="size-7"
        pressed={status === "changes-requested"}
        onClick={() => act("changes-requested")}
      />
      {props.drafts.length > 0 && (
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="ghost" />}>Comments</MenuTrigger>
          <MenuContent
            align="end"
            className="max-h-[min(360px,var(--available-height))] w-[340px] overflow-y-auto"
          >
            {groups.map((group) => {
              const entries = props.drafts.filter(group.match);
              if (!entries.length) return null;
              return (
                <MenuGroup key={group.label} aria-label={group.label}>
                  <MenuLabel>{group.label}</MenuLabel>
                  {entries.map((draft) => (
                    <MenuItem
                      key={draft.key}
                      onClick={() => props.onJump(draft.file)}
                      className="h-auto flex-col items-start gap-0 py-1.5"
                    >
                      <span className="block w-full truncate font-mono text-xs text-subtle-foreground">
                        {draft.file}:{draft.line}
                      </span>
                      <span className="block w-full truncate">{draft.text}</span>
                    </MenuItem>
                  ))}
                </MenuGroup>
              );
            })}
          </MenuContent>
        </Menu>
      )}
      {pending.length > 0 && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => props.onSend(pending.map((draft) => draft.key))}
        >
          Send {pending.length === 1 ? "comment" : `${pending.length} comments`} to agent
        </Button>
      )}
    </section>
  );
}
