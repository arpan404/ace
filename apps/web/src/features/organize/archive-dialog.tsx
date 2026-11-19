import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import type { ArchiveRequest, ArchiveStopsRequest } from "./delete-confirmation.ts";

/**
 * Archiving a thread that still works or waits on the person: archiving alone leaves its agents
 * and commands running out of sight, so the person chooses. Stop & archive ends work, so it is the
 * danger action and focus starts on Cancel. Archiving done threads that left commands running
 * stops those commands, so it asks that alone: Archive or Cancel.
 */
export function ArchiveDialog(props: { request: ArchiveRequest; onClose(): void }) {
  const { request } = props;
  if (request.kind === "stops")
    return <ArchiveStopsDialog request={request} onClose={props.onClose} />;
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
          <Button variant="danger" onClick={choose(request.stopAndArchive)}>
            Stop &amp; archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveStopsDialog(props: { request: ArchiveStopsRequest; onClose(): void }) {
  const { request } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{request.question.title}</DialogTitle>
        <DialogDescription>{request.question.message}</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {/* Archive, not Stop: never red (DESIGN.md), though it ends the commands it names. */}
          <Button
            variant="primary"
            onClick={() => {
              props.onClose();
              request.archive();
            }}
          >
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
