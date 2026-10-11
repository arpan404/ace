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

type Write = Extract<GitChange, { kind: "merge" | "push" }>;

/** A final review before the existing reconciled command path performs a remote write. */
export function GitWriteConfirm(props: {
  change: Write;
  branch: string;
  pending: boolean;
  onSubmit(change: Write): Promise<void>;
  onClose(): void;
  renderError(error: unknown): ReactNode;
}) {
  const [error, setError] = useState<unknown>();
  const change = props.change;
  const label = change.kind === "push" ? "Push" : change.auto ? "Enable auto-merge" : "Merge";
  const target = change.kind === "push" ? props.branch : `PR #${change.pr?.number ?? ""}`;
  return (
    <Dialog open onOpenChange={(open) => !open && !props.pending && props.onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {label} {target}?
          </DialogTitle>
          <DialogDescription>
            {change.kind === "push"
              ? "Push this branch to origin."
              : `Use ${change.method} to merge ${change.pr?.repository.owner}/${change.pr?.repository.name}#${change.pr?.number}. GitHub will refuse if that head has changed.${change.auto ? " GitHub will merge when its requirements pass." : ""}`}
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <div role="alert" className="text-sm text-status-failed">
            {props.renderError(error)}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={props.pending} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={props.pending || error !== undefined}
            onClick={() => {
              void props
                .onSubmit(change)
                .then(props.onClose, (reason: unknown) => setError(reason));
            }}
          >
            {props.pending ? "Working…" : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
