import type { ForgeLifecycleAction } from "@ace/protocol";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import type { PrActions } from "./pr-actions.ts";
import { PrMetadataEditor } from "./pr-metadata-editor.tsx";
import { useRepoMilestones } from "./pr-repo-options.ts";
import { PrRevertForm } from "./pr-revert-form.tsx";
import { PrConflictsDialog } from "./pr-conflicts-view.tsx";
import { DeleteBranchDialog, LinkIssueDialog, LockDialog } from "./pr-manage-dialogs.tsx";
import { RequestReviewDialog } from "./pr-request-review.tsx";

export type PrDialog =
  | "edit"
  | "revert"
  | "review"
  | "conflicts"
  | "lock"
  | "link-issue"
  | "delete-branch"
  | undefined;

/**
 * The forms the ⋯ menu, the Summary's pencils and Resolve conflicts open: edit details, revert,
 * request review, resolve conflicts, lock the conversation, link an issue, delete the branch.
 */
export function PrDialogs(props: {
  actions: PrActions;
  hostThreadId?: string | undefined;
  open: PrDialog;
  onClose(): void;
}) {
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
  const milestones = useRepoMilestones(
    context.workspaceId,
    context.detail.status.ref.repository,
    props.open === "edit" && !!snapshot?.editableFields.includes("milestone"),
  );
  return (
    <>
      <Dialog open={props.open === "edit"} onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Edit pull request</DialogTitle>
          </DialogHeader>
          {snapshot && (
            <PrMetadataEditor
              key={key}
              snapshot={snapshot}
              disabled={disabled}
              apply={apply}
              applyLatest={async (action) => {
                const ok = await lifecycle.applyLatest(action);
                if (ok) props.onClose();
                return ok;
              }}
              milestones={milestones.data}
            />
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
      <PrConflictsDialog
        actions={props.actions}
        hostThreadId={props.hostThreadId}
        open={props.open === "conflicts"}
        onClose={props.onClose}
      />
      <LockDialog actions={props.actions} open={props.open === "lock"} onClose={props.onClose} />
      <LinkIssueDialog
        actions={props.actions}
        open={props.open === "link-issue"}
        onClose={props.onClose}
      />
      <DeleteBranchDialog
        actions={props.actions}
        open={props.open === "delete-branch"}
        onClose={props.onClose}
      />
    </>
  );
}
