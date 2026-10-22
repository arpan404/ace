import { useState } from "react";
import { mergeMethods, type MergeMethod } from "@ace/ui-core";
import type { ForgeMergeCommit, ForgeMergeState, ForgePrDetail } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import type { PrActions } from "./pr-actions.ts";

/**
 * The commit a merge or squash writes, as GitHub would prefill it: its own text for this account
 * when it says, else its defaults (a merge names the PR and branch; a squash is the PR's title
 * with its number and the description below).
 */
export function defaultMergeCommit(
  detail: ForgePrDetail,
  method: Exclude<MergeMethod, "rebase">,
  state: ForgeMergeState | undefined,
): ForgeMergeCommit {
  const own = state?.commitMessages?.[method];
  if (own) return own;
  const { status } = detail;
  const owner = detail.headRepository?.owner ?? status.ref.repository.owner;
  return method === "merge"
    ? {
        title: `Merge pull request #${status.ref.number} from ${owner}/${detail.headBranch}`,
        message: status.title,
      }
    : { title: `${status.title} (#${status.ref.number})`, message: detail.body };
}

/**
 * Edit the merge or squash commit before merging now or arming auto-merge. Opened with
 * GitHub's prefill; what is confirmed is what GitHub writes.
 */
export function PrMergeCommitDialog(props: {
  actions: PrActions;
  /** Merge now, or when auto-merge's requirements pass; undefined while closed. */
  when: "now" | "auto" | undefined;
  onClose(): void;
}) {
  const { actions } = props;
  return (
    <Dialog open={props.when !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        {props.when && actions.method !== "rebase" && (
          <CommitForm
            // A new method or head starts again from GitHub's prefill.
            key={`${actions.method}:${actions.context.detail.status.headSha}`}
            actions={actions}
            method={actions.method}
            when={props.when}
            onClose={props.onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CommitForm(props: {
  actions: PrActions;
  method: Exclude<MergeMethod, "rebase">;
  when: "now" | "auto";
  onClose(): void;
}) {
  const { actions, method } = props;
  const prefill = defaultMergeCommit(actions.context.detail, method, actions.mergeState.state);
  const [title, setTitle] = useState(prefill.title);
  const [message, setMessage] = useState(prefill.message);
  const label = mergeMethods.find((each) => each.method === method)?.label ?? "Merge";
  const blocked = props.when === "now" ? actions.mergeBlocked : actions.autoMergeBlocked;
  const base = actions.context.detail.baseBranch;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || blocked) return;
        const commit = { title: title.trim(), message };
        props.onClose();
        void (props.when === "now"
          ? actions.writes.merge(method, commit)
          : actions.mergeState.run("enable", method, commit));
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {props.when === "now" ? `${label} into ${base}` : `${label} into ${base} automatically`}
        </DialogTitle>
      </DialogHeader>
      <label className="flex flex-col gap-1 text-sm">
        Commit title
        <Input
          aria-label="Commit title"
          value={title}
          maxLength={1_024}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to edit this.
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Commit message
        <Textarea
          aria-label="Commit message"
          value={message}
          maxLength={65_536}
          rows={10}
          className="font-mono text-xs"
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      {blocked && (
        <p role="status" className="text-ui text-muted-foreground">
          {blocked}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!title.trim() || blocked !== undefined}>
          {props.when === "now" ? `Confirm ${label.toLowerCase()}` : "Enable auto-merge"}
        </Button>
      </DialogFooter>
    </form>
  );
}
