import { useGitFlow } from "./use-git-flow.tsx";
import { PrLinkForm } from "./pr-link-form.tsx";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";
import type { ThreadRef } from "../sources/index.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";

export function PrLinksDialog(props: {
  thread: ThreadRef;
  kind: "link" | "unlink";
  onClose(): void;
}) {
  const git = useGitFlow(props.thread);
  if (props.kind === "unlink")
    return (
      <PrUnlinkDialog
        onClose={props.onClose}
        onUnlink={() => git.submit({ kind: "unlink-pr", all: true })}
      />
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link pull request</DialogTitle>
          <DialogDescription>Add a pull request to this thread.</DialogDescription>
        </DialogHeader>
        <PrLinkForm
          repository={git.checkout?.repository}
          pending={git.pending}
          onLink={(number, repository) =>
            git.submit({ kind: "link-pr", number, ...(repository ? { repository } : {}) })
          }
          onDone={props.onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
