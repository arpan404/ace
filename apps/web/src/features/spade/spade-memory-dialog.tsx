import { SettingCard } from "@/components/setting-row.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { SpadeNotes } from "./spade-notes.tsx";

/** A bot's Memory from its ⋯ menu (ADR 0128): its own notes, edited in place. */
export function MemoryDialog(props: { bot: { id: string; name: string }; onClose(): void }) {
  const { bot } = props;
  const title = `${bot.name}'s memory`;
  return (
    <Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <SettingCard>
            <SpadeNotes
              scope={{ kind: "agent", agent: bot.id }}
              label={title}
              placeholder={`Add something for ${bot.name} to remember`}
            />
          </SettingCard>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
