import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import type { ArchiveRequest } from "./delete-confirmation.ts";

/**
 * Archiving a thread that still works or waits on the person: archiving alone leaves its agents
 * and commands running out of sight, so the person chooses. Stop & archive is the default.
 */
export function ArchiveDialog(props: { request: ArchiveRequest; onClose(): void }) {
  const { request } = props;
  const choose = (run: () => void) => () => {
    props.onClose();
    run();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Archive a running thread?</DialogTitle>
        <DialogDescription>
          {request.title} · {request.running}
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={choose(request.archive)}>
            Archive, keep running
          </Button>
          <Button variant="primary" onClick={choose(request.stopAndArchive)}>
            Stop &amp; archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
