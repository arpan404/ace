import { useClient } from "@ace/client-react";
import { inputWithText, sendBusyReason, tokensFromInput } from "@ace/ui-core";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import type { SendPayload } from "../composer/returned-draft.ts";

/**
 * Edit of a send that didn't go, in place in this device's outbox: its full words in a field,
 * saved under the same send in one write (`ClientCore.editFailedSend`), so the original stays
 * until the edit is saved and nothing is removed to edit it. Retry then sends the new words. An
 * edit never runs beside a retry of the same send (`client.sendOps`): while one runs, Save says
 * why it waits and keeps the words.
 */
export function EditSendDialog(props: {
  commandId: string;
  payload: SendPayload;
  onClose(): void;
}) {
  const client = useClient();
  const [text, setText] = useState(() => tokensFromInput(props.payload.input).text);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const descriptionId = useId();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !text.trim()) return;
    setSaving(true);
    try {
      // The send as it is now: another window may have changed it since this opened.
      const current = client.pendingSend(props.commandId)?.payload ?? props.payload;
      const ran = await client.sendOps.run(props.commandId, "editing", () =>
        client.editFailedSend(props.commandId, {
          ...current,
          input: inputWithText(current.input, text.trim()),
        }),
      );
      if (ran.ran) props.onClose();
      else setProblem(sendBusyReason(ran.running));
    } catch {
      setProblem("Couldn't save the edit on this device. The original is still here.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && props.onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3">
          <DialogTitle>Edit message</DialogTitle>
          <DialogDescription id={descriptionId}>
            Saved in place. Retry then sends the new words.
          </DialogDescription>
          <textarea
            aria-label="Message"
            aria-describedby={descriptionId}
            // The person asked to edit: the words are where they type.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            rows={Math.min(12, Math.max(3, text.split("\n").length))}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="block max-h-[50vh] w-full resize-none overflow-y-auto rounded-md bg-field px-2.5 py-2 text-sm text-foreground shadow-(--depth-well) outline-none focus-ring"
          />
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter submitHint>
            <Button type="button" variant="ghost" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !text.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
