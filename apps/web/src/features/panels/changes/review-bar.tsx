import { ArrowClockwiseIcon, ChatCircleTextIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
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
 * The thread's review at a glance, under the toolbar while it has comments: how many still need
 * sending, how many the agent has, how many are resolved; Send sends every unsent one at once,
 * Comments lists them all and jumps to one.
 */
export function ReviewBar(props: {
  drafts: readonly ReviewDraft[];
  onSend(keys: readonly string[]): void;
  onJump(file: string): void;
  onRefresh(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pending = props.drafts.filter(isPending);
  const anySent = props.drafts.some((draft) => draft.commentId);
  if (!props.drafts.length) return null;
  return (
    <section
      aria-label="Review"
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-panel pr-2 pl-3.5 text-sm"
    >
      <Icon icon={ChatCircleTextIcon} size={14} className="text-subtle-foreground" />
      <span role="status" className="min-w-0 flex-1 truncate text-muted-foreground">
        {reviewSummary(props.drafts)}
      </span>
      {anySent && (
        <IconButton
          icon={ArrowClockwiseIcon}
          label="Check what the daemon holds for these comments"
          size="sm"
          className="size-7"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void props.onRefresh().finally(() => setRefreshing(false));
          }}
        />
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button size="sm" variant="ghost" />}>Comments</PopoverTrigger>
        <PopoverContent align="end" className="w-[340px] p-1.5">
          <PopoverTitle className="px-2 pt-1 pb-1.5 text-sm font-medium">
            Review comments
          </PopoverTitle>
          <div className="max-h-[320px] overflow-y-auto">
            {groups.map((group) => {
              const entries = props.drafts.filter(group.match);
              if (!entries.length) return null;
              return (
                <section key={group.label} aria-label={group.label}>
                  <h3 className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium tracking-[0.02em] text-subtle-foreground">
                    {group.label}
                  </h3>
                  <ul>
                    {entries.map((draft) => (
                      <li key={draft.key}>
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            props.onJump(draft.file);
                          }}
                          className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                        >
                          <span className="truncate font-mono text-[11.5px] text-subtle-foreground">
                            {draft.file}:{draft.line}
                          </span>
                          <span
                            className={cn(
                              "truncate text-sm text-foreground",
                              draft.state === "resolved" && "text-muted-foreground",
                            )}
                          >
                            {draft.text}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {pending.length > 0 && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => props.onSend(pending.map((draft) => draft.key))}
        >
          Send {pending.length === 1 ? "comment" : `${pending.length} comments`} to agent
        </Button>
      )}
      {refreshing && <Spinner label="Checking comments" />}
    </section>
  );
}
