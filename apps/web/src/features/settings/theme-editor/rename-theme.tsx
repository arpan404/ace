import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/** Rename a custom theme. Empty names are refused; the name is trimmed and capped at 80. */
export function RenameTheme(props: {
  open: boolean;
  name: string;
  onOpenChange(open: boolean): void;
  onRename(name: string): void;
}) {
  const [draft, setDraft] = useState(props.name);
  const name = draft.trim().slice(0, 80);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) setDraft(props.name);
        props.onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename theme</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name) return;
            props.onRename(name);
            props.onOpenChange(false);
          }}
        >
          <Input
            aria-label="Theme name"
            value={draft}
            maxLength={80}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
