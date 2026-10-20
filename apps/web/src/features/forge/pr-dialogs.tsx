import { useState } from "react";
import { parseReviewers } from "@ace/ui-core";
import type { ForgeLifecycleAction } from "@ace/protocol";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { PrActions } from "./pr-actions.ts";
import { PrMetadataEditor } from "./pr-metadata-editor.tsx";
import { PrRevertForm } from "./pr-revert-form.tsx";

export type PrDialog = "edit" | "revert" | "review" | undefined;

/** The forms the ⋯ menu and the Summary's pencils open: edit details, revert, request review. */
export function PrDialogs(props: { actions: PrActions; open: PrDialog; onClose(): void }) {
  const { lifecycle, context } = props.actions;
  const snapshot = lifecycle.snapshot;
  const disabled = lifecycle.blocked;
  // A form closes once GitHub accepts it; a refusal keeps it open with the text intact.
  const apply = async (action: ForgeLifecycleAction, version: string) => {
    const ok = await lifecycle.apply(action, version);
    if (ok) props.onClose();
    return ok;
  };
  const key = JSON.stringify(context.detail.status.ref);
  return (
    <>
      <Dialog open={props.open === "edit"} onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Edit pull request</DialogTitle>
          </DialogHeader>
          {snapshot && (
            <PrMetadataEditor key={key} snapshot={snapshot} disabled={disabled} apply={apply} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={props.open === "revert"} onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Revert changes</DialogTitle>
          </DialogHeader>
          {snapshot && (
            <PrRevertForm key={key} snapshot={snapshot} disabled={disabled} apply={apply} />
          )}
        </DialogContent>
      </Dialog>
      <RequestReviewDialog
        actions={props.actions}
        open={props.open === "review"}
        onClose={props.onClose}
      />
    </>
  );
}

function RequestReviewDialog(props: { actions: PrActions; open: boolean; onClose(): void }) {
  const [text, setText] = useState("");
  const parsed = parseReviewers(text);
  const { writes, context } = props.actions;
  const reviewers = "reviewers" in parsed ? parsed.reviewers : [];
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reviewers.length) return;
            props.onClose();
            void writes.requestReview(reviewers).then(() => setText(""));
          }}
        >
          <DialogHeader>
            <DialogTitle>Request review</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Reviewers"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="GitHub usernames"
          />
          {"error" in parsed && text.trim() && (
            <p role="status" className="text-xs text-muted-foreground">
              {parsed.error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!reviewers.length || writes.fenced || writes.pending || context.disabled}
            >
              Request review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
