import { spadeNoteMax, type SpadeNote } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingList, SettingListItem, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  addNote,
  deleteNote,
  editNote,
  readNotes,
  type SpadeNotesScope,
} from "./spade-notes-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/** Every notes read; one scope's under `[...notesKey, machine key, scope]`. */
export const notesKey = ["spade", "notes"] as const;

const scopeKey = (scope: SpadeNotesScope) => (scope.kind === "agent" ? scope.agent : "shared");
const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * What a bot remembers, or what every bot knows about the person (ADR 0128), as a list edited
 * in place: a note's text opens it for editing, Delete removes it, the last row adds one.
 * `editing`: a note to open for editing at once (from a "Remembered" line). Put it in a card.
 */
export function SpadeNotes(props: {
  scope: SpadeNotesScope;
  label: string;
  placeholder: string;
  editing?: string | undefined;
}) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const toast = useToast();
  const key = [...notesKey, machine, scopeKey(props.scope)];
  const notes = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readNotes(client, props.scope, { signal }),
  });
  const [editing, setEditing] = useState(props.editing);
  /** Runs a change, then reads the list again; says why when it fails. */
  const change = async (title: string, run: () => Promise<unknown>) => {
    try {
      await run();
      await cache.invalidateQueries({ queryKey: key });
      return true;
    } catch (error) {
      toast.error({ title, description: fault(error) });
      return false;
    }
  };
  if (notes.isPending) return <ListSkeleton label="notes" shape="row" rows={2} />;
  if (notes.isError)
    return (
      <SettingRow title="Couldn't read the notes" description={notes.error.message}>
        <Button size="sm" variant="ghost" onClick={() => void notes.refetch()}>
          Try again
        </Button>
      </SettingRow>
    );
  return (
    <>
      {notes.data.length > 0 && (
        <SettingList aria-label={props.label}>
          {notes.data.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              editing={editing === note.id}
              onEdit={(open) => setEditing(open ? note.id : undefined)}
              onSave={(text) =>
                change("Couldn't change the note", () => editNote(client, note.id, text))
              }
              onDelete={() =>
                void change("Couldn't delete the note", () => deleteNote(client, note.id))
              }
            />
          ))}
        </SettingList>
      )}
      <AddNote
        placeholder={props.placeholder}
        onAdd={(text) => change("Couldn't add the note", () => addNote(client, props.scope, text))}
      />
    </>
  );
}

function NoteRow(props: {
  note: SpadeNote;
  editing: boolean;
  onEdit(open: boolean): void;
  onSave(text: string): Promise<boolean>;
  onDelete(): void;
}) {
  const { note } = props;
  if (props.editing)
    return (
      <SettingListItem>
        <NoteField
          initial={note.text}
          label="Note"
          action="Save"
          onDone={() => props.onEdit(false)}
          onSubmit={async (text) => {
            if (text === note.text) return true;
            return props.onSave(text);
          }}
        />
      </SettingListItem>
    );
  return (
    <SettingListItem>
      <button
        type="button"
        aria-label={`Edit: ${note.text}`}
        onClick={() => props.onEdit(true)}
        className="min-w-0 flex-1 rounded-sm text-left text-ui wrap-anywhere text-foreground focus-ring"
      >
        {note.text}
      </button>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Delete: ${note.text}`}
        className="-mr-2.5"
        onClick={props.onDelete}
      >
        Delete
      </Button>
    </SettingListItem>
  );
}

function AddNote(props: { placeholder: string; onAdd(text: string): Promise<boolean> }) {
  // Keyed by each add so the field empties once a note goes in.
  const [round, setRound] = useState(0);
  return (
    <div data-setting-slot="" className="flex min-h-(--setting-row-height) items-center gap-2">
      <NoteField
        key={round}
        initial=""
        label={props.placeholder}
        placeholder={props.placeholder}
        action="Add"
        onSubmit={async (text) => {
          const added = await props.onAdd(text);
          if (added) setRound((value) => value + 1);
          return added;
        }}
      />
    </div>
  );
}

/** One line of text with its action: Enter does it, Escape gives up (`onDone`, when given). */
function NoteField(props: {
  initial: string;
  label: string;
  placeholder?: string;
  action: "Save" | "Add";
  onSubmit(text: string): Promise<boolean>;
  onDone?(): void;
}) {
  const [text, setText] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const ready = text.trim() !== "" && !saving;
  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    const done = await props.onSubmit(text.trim());
    setSaving(false);
    if (done) props.onDone?.();
  };
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        aria-label={props.label}
        value={text}
        maxLength={spadeNoteMax}
        placeholder={props.placeholder}
        autoFocus={props.onDone !== undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.onDone) {
            event.stopPropagation();
            props.onDone();
          }
        }}
        className="flex-1"
      />
      <Button type="submit" size="sm" variant="ghost" disabled={!ready}>
        {saving ? (props.action === "Save" ? "Saving…" : "Adding…") : props.action}
      </Button>
      {props.onDone && (
        <Button size="sm" variant="ghost" className="-mr-2.5" onClick={props.onDone}>
          Cancel
        </Button>
      )}
    </form>
  );
}
