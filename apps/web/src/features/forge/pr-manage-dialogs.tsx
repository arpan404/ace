import { useState } from "react";
import { ForgeIssueSearch, type ForgeLockReason } from "@ace/protocol";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { useDebouncedValue } from "@/lib/debounced.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { lockReasonLabels } from "./pr-lock-reasons.ts";
import { readFailureText } from "./query-state.tsx";

const noReason = "none";
const reasons = Object.keys(lockReasonLabels) as ForgeLockReason[];

/** Lock the conversation, with one of GitHub's reasons or none. */
export function LockDialog(props: { actions: PrActions; open: boolean; onClose(): void }) {
  const { lifecycle } = props.actions;
  const [reason, setReason] = useState<string>(noReason);
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const picked = reasons.find((each) => each === reason) ?? null;
            void lifecycle.apply({ kind: "lock", reason: picked }).then((ok) => {
              if (ok) props.onClose();
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Lock conversation</DialogTitle>
            <DialogDescription>
              Only collaborators who can push will be able to comment, review or react.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-label="Reason"
            value={reason}
            onValueChange={(value) => typeof value === "string" && setReason(value)}
            className="gap-0.5"
          >
            {[noReason, ...reasons].map((value) => (
              <label
                key={value}
                className={cn(
                  "flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-1.5 text-ui hover:bg-hover",
                  reason === value ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <RadioGroupItem value={value} />
                {value === noReason
                  ? "No reason"
                  : lockReasonLabels[reasons.find((each) => each === value) ?? "resolved"]}
              </label>
            ))}
          </RadioGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={lifecycle.blocked}>
              Lock conversation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pick an open issue of the PR's repository for it to close, by searching or by number. GitHub
 * links it the way its Development field does, so the issue closes when this PR merges.
 */
export function LinkIssueDialog(props: { actions: PrActions; open: boolean; onClose(): void }) {
  const { lifecycle, context } = props.actions;
  const repository = context.detail.status.ref.repository;
  const [text, setText] = useState("");
  const search = useDebouncedValue(text.trim(), 250);
  const typed = /^#?(\d{1,9})$/.exec(search)?.[1];
  const linked = new Set(
    (lifecycle.snapshot?.closingIssues ?? []).map((issue) => issue.ref.number),
  );
  const query = useDaemonQuery({
    queryKey: ["forge", context.workspaceId, repository, "link-issue", search],
    enabled: props.open,
    retry: false,
    staleTime: 30_000,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        {
          op: "forge.issue.list",
          workspaceId: context.workspaceId,
          repository,
          query: ForgeIssueSearch.parse({ state: "open", search: typed ? "" : search }),
        },
        signal,
      );
      if (result.resource !== "issueList") throw new Error("No issues returned.");
      return result.value.items;
    },
  });
  const link = (issue: number) =>
    void lifecycle.apply({ kind: "issue.link", issue }).then((ok) => {
      if (!ok) return;
      setText("");
      props.onClose();
    });
  const rows = (query.data ?? []).filter(
    (issue) => !linked.has(issue.ref.number) && (!typed || String(issue.ref.number) === typed),
  );
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link an issue</DialogTitle>
          <DialogDescription>
            The issue closes when this pull request merges into the default branch.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search issues"
          placeholder="Search open issues or type a number"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <ul aria-label="Open issues" className="-mx-1.5 max-h-72 overflow-y-auto">
          {typed && !rows.length && !linked.has(Number(typed)) && (
            <li>
              <IssueChoice
                number={Number(typed)}
                title="Link this issue"
                disabled={lifecycle.blocked}
                onPick={link}
              />
            </li>
          )}
          {rows.map((issue) => (
            <li key={issue.ref.number}>
              <IssueChoice
                number={issue.ref.number}
                title={issue.title}
                disabled={lifecycle.blocked}
                onPick={link}
              />
            </li>
          ))}
          {query.isError && (
            <li className="px-1.5 py-2 text-ui text-muted-foreground">
              {readFailureText(query.error)}
            </li>
          )}
          {query.isSuccess && !rows.length && !typed && (
            <li className="px-1.5 py-2 text-ui text-muted-foreground">No open issues match.</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function IssueChoice(props: {
  number: number;
  title: string;
  disabled: boolean;
  onPick(number: number): void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onPick(props.number)}
      className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-ui focus-ring-inset hover:bg-hover disabled:opacity-50"
    >
      <span className="shrink-0 text-subtle-foreground tabular-nums">#{props.number}</span>
      <span className="truncate text-foreground">{props.title}</span>
    </button>
  );
}

/** Deleting the head branch on GitHub, confirmed first. Local branches stay as they are. */
export function DeleteBranchDialog(props: { actions: PrActions; open: boolean; onClose(): void }) {
  const { lifecycle } = props.actions;
  const branch = lifecycle.snapshot?.headBranch?.name ?? props.actions.context.detail.headBranch;
  return (
    <ConfirmDialog
      confirming={
        props.open
          ? {
              title: `Delete ${branch}?`,
              body: "The branch is deleted on GitHub. It can be restored from this pull request; branches and worktrees on this computer stay as they are.",
              confirm: "Delete branch",
              run: () => void lifecycle.apply({ kind: "branch.delete" }),
            }
          : undefined
      }
      onDone={props.onClose}
    />
  );
}
