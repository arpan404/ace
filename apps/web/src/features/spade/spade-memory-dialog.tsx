import { SettingCard } from "@/components/setting-row.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { SpadeNotes } from "./spade-notes.tsx";

/** Which notes the dialog shows, and a note to open for editing at once. */
export type MemoryOpen = { shared: boolean; note?: string };

/**
 * A bot's Memory from its menu (ADR 0128): its own notes, edited in place. From a shared note's
 * "Remembered" line, the "About you" notes every bot sees instead.
 */
export function MemoryDialog(props: {
  bot: { id: string; name: string };
  open: MemoryOpen;
  onClose(): void;
}) {
  const { bot, open } = props;
  const title = open.shared ? "About you" : `${bot.name}'s memory`;
  return (
    <Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <SettingCard>
            <SpadeNotes
              scope={open.shared ? { kind: "shared" } : { kind: "agent", agent: bot.id }}
              label={title}
              placeholder={
                open.shared
                  ? "Add something about you"
                  : `Add something for ${bot.name} to remember`
              }
              editing={open.note}
            />
          </SettingCard>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
