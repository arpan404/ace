import type { QueuedMessage } from "@ace/protocol";
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
import { Textarea } from "@/components/ui/input.tsx";
import { queuedText, type QueueControls } from "./use-queue.ts";

/** Keep the edit draft alive even if the daemon dispatches or removes its row. */
export function QueuedEdit(props: {
  message: QueuedMessage;
  queue: QueueControls;
  onClose(): void;
}) {
  const [text, setText] = useState(() => queuedText(props.message));
  const [saving, setSaving] = useState(false);
  const current = props.queue.messages.find((message) => message.id === props.message.id);
  const gone = !current;
  const changed = !!current && queuedText(current) !== queuedText(props.message);
  const unavailable = gone || changed || current?.state === "uncertain";
  const busy = saving || props.queue.busy(props.message.id);
  const save = async () => {
    if (!current || unavailable || busy) return;
    setSaving(true);
    const saved = await props.queue.edit(current, text);
    setSaving(false);
    if (saved) props.onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit queued message</DialogTitle>
          <DialogDescription>Files and references stay attached when you save.</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Queued message text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          readOnly={busy}
        />
        {unavailable && !saving && (
          <p role="status" className="text-sm text-muted-foreground">
            {gone
              ? "This message has left the queue. Your edits are still here to copy."
              : changed
                ? "This message changed while you were editing. Copy your edits, then reopen it to edit the latest version."
                : "This message may have been sent. Your edits are still here to copy."}
          </p>
        )}
        <DialogFooter submitHint>
          <Button
            variant="ghost"
            disabled={busy || gone}
            title="Return the original queued message to the composer"
            onClick={() => {
              if (current) {
                props.queue.takeBack(current);
                props.onClose();
              }
            }}
          >
            Take back to composer
          </Button>
          <Button variant="ghost" disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || unavailable || (!text.trim() && !!queuedText(props.message))}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
