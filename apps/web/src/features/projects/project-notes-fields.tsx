import type { ProjectNoteEdit } from "@ace/protocol";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

const maxNotes = 50;

/**
 * Facts every agent in the project reads, whoever wrote them. Kept in ace, never in the repo.
 * Editing a note here makes it the person's; clearing one removes it on save.
 */
export function ProjectNotesFields(props: {
  value: ProjectNoteEdit[];
  onChange(value: ProjectNoteEdit[]): void;
  disabled?: boolean;
}) {
  const { value, onChange } = props;
  const set = (index: number, text: string) =>
    onChange(value.map((note, at) => (at === index ? { ...note, text } : note)));
  return (
    <div role="group" aria-label="Notes" className="grid gap-1.5">
      <h3 className="text-sm font-medium text-muted-foreground">Notes</h3>
      {value.map((note, index) => (
        <div key={note.id ?? `new-${index}`} className="flex items-center gap-1.5">
          <Input
            aria-label={`Note ${index + 1}`}
            value={note.text}
            maxLength={500}
            disabled={props.disabled}
            onChange={(event) => set(index, event.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove note ${index + 1}`}
            disabled={props.disabled}
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            <Icon icon={XIcon} />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={props.disabled || value.length >= maxNotes}
          onClick={() => onChange([...value, { text: "" }])}
        >
          <Icon icon={PlusIcon} />
          Add note
        </Button>
      </div>
    </div>
  );
}
