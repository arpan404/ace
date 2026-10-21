import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/** Rename an automation; it closes once the daemon has the new name. */
export function RenameDialog(props: {
  open: boolean;
  title: string;
  onClose(): void;
  onRename(title: string): Promise<boolean>;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>{props.open && <RenameForm {...props} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm(props: {
  title: string;
  onClose(): void;
  onRename(title: string): Promise<boolean>;
}) {
  const [title, setTitle] = useState(props.title);
  const [saving, setSaving] = useState(false);
  const name = title.trim();
  const submit = () => {
    if (!name || name === props.title || saving) return;
    setSaving(true);
    void props.onRename(name).then((saved) => {
      setSaving(false);
      if (saved) props.onClose();
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename automation</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Input aria-label="Name" autoFocus maxLength={256} value={title} onValueChange={setTitle} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name || name === props.title || saving}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
