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

/** Longest tab title kept; the strip truncates long ones anyway. */
const maxTitle = 80;

/**
 * Rename a tab. The name is this thread's label for it on this device (the daemon has no name
 * to change), so clearing it brings back the shell's own name.
 */
export function RenameDialog(props: {
  open: boolean;
  title: string;
  current: string;
  /** The name an empty field restores. */
  fallback: string;
  onOpenChange(open: boolean): void;
  onRename(name: string): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.open && <RenameForm {...props} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm(props: Parameters<typeof RenameDialog>[0]) {
  const [value, setValue] = useState(props.current);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onRename(value.trim().slice(0, maxTitle) || props.fallback);
        props.onOpenChange(false);
      }}
    >
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>
          Shown on its tab in this thread. Leave it empty to use “{props.fallback}”.
        </DialogDescription>
      </DialogHeader>
      <Input
        aria-label="Name"
        value={value}
        maxLength={maxTitle}
        // The dialog opens to change this name, so the field starts with it selected.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
      />
      <DialogFooter submitHint>
        <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
