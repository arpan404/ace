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
  const { actions, when } = props;
  const method = actions.method;
  const label = mergeMethods.find((each) => each.method === method)?.label ?? "Merge";
  const base = actions.context.detail.baseBranch;
  return (
    <Dialog open={when !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        {when && method !== "rebase" && (
          <MergeCommitForm
            // A new method starts again from its own prefill; a push keeps what was written.
            key={method}
            heading={when === "now" ? `${label} into ${base}` : `${label} into ${base} automatically`}
            confirm={when === "now" ? `Confirm ${label.toLowerCase()}` : "Enable auto-merge"}
            prefill={defaultMergeCommit(actions.context.detail, method, actions.mergeState.state)}
            headSha={actions.context.detail.status.headSha}
            blocked={when === "now" ? actions.mergeBlocked : actions.autoMergeBlocked}
            onCancel={props.onClose}
            onSubmit={(commit) => {
              props.onClose();
              void (when === "now"
                ? actions.writes.merge(method, commit)
                : actions.mergeState.run("enable", method, commit));
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The commit's title and message. What the person writes stays through pushes and refreshes:
 * a field still as GitHub prefilled it follows GitHub's new text; an edited one keeps its words
 * and offers the new text instead. New commits on the branch are said, since the merge takes
 * the branch as it is when confirmed.
 */
export function MergeCommitForm(props: {
  heading: string;
  confirm: string;
  prefill: ForgeMergeCommit;
  headSha: string;
  blocked: string | undefined;
  onCancel(): void;
  onSubmit(commit: ForgeMergeCommit): void;
}) {
  const { prefill } = props;
  const [title, setTitle] = useState(prefill.title);
  const [message, setMessage] = useState(prefill.message);
  const [openedAt] = useState(props.headSha);
  // The prefill the fields were last given, and GitHub's newer text an edit is keeping out.
  const [seen, setSeen] = useState(prefill);
  const [offer, setOffer] = useState<ForgeMergeCommit>();
  if (prefill.title !== seen.title || prefill.message !== seen.message) {
    const titleEdited = title !== seen.title;
    const messageEdited = message !== seen.message;
    if (!titleEdited) setTitle(prefill.title);
    if (!messageEdited) setMessage(prefill.message);
    setSeen(prefill);
    const held =
      (titleEdited && prefill.title !== seen.title) ||
      (messageEdited && prefill.message !== seen.message);
    setOffer(held ? prefill : undefined);
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || props.blocked) return;
        props.onSubmit({ title: title.trim(), message });
      }}
    >
      <DialogHeader>
        <DialogTitle>{props.heading}</DialogTitle>
      </DialogHeader>
      {(props.headSha !== openedAt || offer) && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-ui text-muted-foreground">
          {props.headSha !== openedAt &&
            "The branch has new commits since this opened; the merge takes them."}
          {offer && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-ml-1.5"
              onClick={() => {
                setTitle(offer.title);
                setMessage(offer.message);
                setOffer(undefined);
              }}
            >
              Use GitHub's new text
            </Button>
          )}
        </p>
      )}
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
      {props.blocked && (
        <p role="status" className="text-ui text-muted-foreground">
          {props.blocked}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!title.trim() || props.blocked !== undefined}
        >
          {props.confirm}
        </Button>
      </DialogFooter>
    </form>
  );
}
