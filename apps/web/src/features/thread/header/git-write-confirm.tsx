import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import type { GitChange } from "../lib/use-git.ts";
import { forceLeaseOf } from "../lib/push-rejection.ts";

type Write = Extract<GitChange, { kind: "merge" | "push" }>;

/**
 * A final review before the existing reconciled command path performs a remote write. A push
 * the remote rejects because it has commits the branch doesn't (after a rebase or amend) offers
 * a force push pinned to the remote revision Git compared against.
 */
export function GitWriteConfirm(props: {
  change: Write;
  branch: string;
  pending: boolean;
  onSubmit(change: Write): Promise<unknown>;
  onClose(): void;
  renderError(error: unknown): ReactNode;
}) {
  const [error, setError] = useState<unknown>();
  const [change, setChange] = useState<Write>(props.change);
  const lease = change.kind === "push" && !change.force ? forceLeaseOf(error) : undefined;
  const label =
    change.kind === "push"
      ? change.force
        ? "Force push"
        : "Push"
      : change.auto
        ? "Enable auto-merge"
        : "Merge";
  const target = change.kind === "push" ? props.branch : `PR #${change.pr?.number ?? ""}`;
  const send = (next: Write) => {
    if (props.pending) return;
    setChange(next);
    setError(undefined);
    void props.onSubmit(next).then(props.onClose, (reason: unknown) => setError(reason));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !props.pending && props.onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {label} {target}?
          </DialogTitle>
          <DialogDescription>
            {change.kind === "push"
              ? change.force
                ? `Replace ${target} on the remote, only while it is still at ${change.force.lease.slice(0, 7)}.`
                : `Push this branch to ${target} on its remote.`
              : `Use ${change.method} to merge ${change.pr?.repository.owner}/${change.pr?.repository.name}#${change.pr?.number}. GitHub will refuse if that head has changed.${change.auto ? " GitHub will merge when its requirements pass." : ""}`}
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <div role="alert" className="text-sm text-status-failed">
            {props.renderError(error)}
          </div>
        )}
        {lease && (
          <p className="text-sm text-muted-foreground">
            Force pushing overwrites the remote's commits at{" "}
            <span className="font-mono">{lease.slice(0, 7)}</span>. Git refuses if anyone pushed
            since.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={props.pending} onClick={props.onClose}>
            Cancel
          </Button>
          {lease ? (
            <Button
              variant="primary"
              disabled={props.pending}
              onClick={() => send({ kind: "push", force: { lease } })}
            >
              {props.pending ? "Working…" : "Force push (with lease)"}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={props.pending || error !== undefined}
              onClick={() => send(change)}
            >
              {props.pending ? "Working…" : label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
