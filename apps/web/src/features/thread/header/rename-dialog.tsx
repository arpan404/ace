import { useState } from "react";
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
import { useThreadActions } from "@/features/organize/index.ts";
import type { ThreadRef } from "../sources/index.ts";

/** Rename the thread. Mounted while open, so it starts from the current title. */
export function RenameDialog(props: { thread: ThreadRef; onClose(): void }) {
  const actions = useThreadActions();
  const [title, setTitle] = useState(props.thread.title);
  // The same rename as Home's: a toast with Undo, or the daemon's refusal.
  const save = () => {
    actions.rename(props.thread, title);
    props.onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
            <DialogDescription>The title shows in the Home list and the header.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Thread title"
            value={title}
            maxLength={256}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
