import { spadeNoteMax, type SpadeNote } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingRow,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  acceptNote,
  addNote,
  deleteNote,
  editNote,
  isNoteConflict,
  readNotes,
  type SpadeNotesScope,
} from "./spade-notes-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/** Every notes read; one scope's under `[...notesKey, machine key, scope]`. */
export const notesKey = ["spade", "notes"] as const;

const scopeKey = (scope: SpadeNotesScope) => (scope.kind === "agent" ? scope.agent : "shared");
const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/** How a save went; `changed`: the note moved on Spade first, nothing was written. */
type Saved =
  | { kind: "saved" }
  | { kind: "failed" }
  | { kind: "changed"; note: SpadeNote | undefined };

/**
 * What a bot remembers, or what every bot knows about the person (ADR 0128), as a list edited
 * in place: a note's text opens it for editing, Delete removes it, the last row adds one.
 * Notes compaction suggested from untrusted content wait above, under Suggested, to be kept or
 * dismissed. `editing`: a note to open for editing at once (from a "Remembered" line). Put it
 * in a card.
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
  const [editing, setEditing] = useState<string | undefined>();
  // A note being opened: the field shows once the notes are read again, so it never starts
  // from cached text the bot has since changed.
  const [opening, setOpening] = useState(props.editing);
  const { refetch } = notes;
  useEffect(() => {
    if (opening === undefined) return;
    let live = true;
    void refetch().then(() => {
      if (!live) return;
      setEditing(opening);
      setOpening(undefined);
    });
    return () => {
      live = false;
    };
  }, [opening, refetch]);
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
  const save = async (id: string, text: string, from: number): Promise<Saved> => {
    try {
      await editNote(client, id, text, from);
      await cache.invalidateQueries({ queryKey: key });
      return { kind: "saved" };
    } catch (error) {
      if (!isNoteConflict(error)) {
        toast.error({ title: "Couldn't change the note", description: fault(error) });
        return { kind: "failed" };
      }
      toast.error({ title: "Changed since you opened it" });
      await cache.invalidateQueries({ queryKey: key });
      const current = cache.getQueryData<SpadeNote[]>(key)?.find((note) => note.id === id);
      return { kind: "changed", note: current };
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
  const suggested = notes.data.filter((note) => note.suggested);
  const kept = notes.data.filter((note) => !note.suggested);
  return (
    <>
      {suggested.length > 0 && (
        <Suggested
          notes={suggested}
          onKeep={(id) => void change("Couldn't keep the note", () => acceptNote(client, id))}
          onDismiss={(id) => void change("Couldn't dismiss the note", () => deleteNote(client, id))}
        />
      )}
      {kept.length > 0 && (
        <SettingList aria-label={props.label}>
          {kept.map((note) =>
            editing === note.id ? (
              <NoteEditor
                key={note.id}
                note={note}
                onSave={(text, from) => save(note.id, text, from)}
                onDone={() => setEditing(undefined)}
              />
            ) : (
              <NoteRow
                key={note.id}
                note={note}
                onEdit={() => setOpening(note.id)}
                onDelete={() =>
                  void change("Couldn't delete the note", () => deleteNote(client, note.id))
                }
              />
            ),
          )}
        </SettingList>
      )}
      <AddNote
        placeholder={props.placeholder}
        onAdd={(text) => change("Couldn't add the note", () => addNote(client, props.scope, text))}
      />
    </>
  );
}

/** Notes waiting for the person: Keep lets the bot see one, Dismiss deletes it. */
function Suggested(props: {
  notes: SpadeNote[];
  onKeep(id: string): void;
  onDismiss(id: string): void;
}) {
  const id = useId();
  return (
    <>
      <SettingNote id={id}>Suggested</SettingNote>
      <SettingList aria-labelledby={id}>
        {props.notes.map((note) => (
          <SettingListItem key={note.id}>
            <span className="min-w-0 flex-1 text-ui wrap-anywhere text-foreground">
              {note.text}
            </span>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Keep: ${note.text}`}
              onClick={() => props.onKeep(note.id)}
            >
              Keep
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Dismiss: ${note.text}`}
              className="-mr-2.5"
              onClick={() => props.onDismiss(note.id)}
            >
              Dismiss
            </Button>
          </SettingListItem>
        ))}
      </SettingList>
    </>
  );
}

function NoteRow(props: { note: SpadeNote; onEdit(): void; onDelete(): void }) {
  const { note } = props;
  return (
    <SettingListItem>
      <button
        type="button"
        aria-label={`Edit: ${note.text}`}
        onClick={props.onEdit}
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

/**
 * A note open for editing. The draft starts from one version of the note (`base`): while it's
 * untouched it follows the note as Spade changes it; once typed in it stays, and Save names
 * that version so Spade refuses rather than overwrite a newer note.
 */
function NoteEditor(props: {
  note: SpadeNote;
  onSave(text: string, from: number): Promise<Saved>;
  onDone(): void;
}) {
  const { note } = props;
  const [base, setBase] = useState(note);
  const [text, setText] = useState(note.text);
  if (note.updatedAt !== base.updatedAt && text === base.text) {
    setBase(note);
    setText(note.text);
  }
  return (
    <SettingListItem>
      <NoteField
        value={text}
        onChange={setText}
        label="Note"
        action="Save"
        onDone={props.onDone}
        onSubmit={async (value) => {
          if (value === base.text) return true;
          const saved = await props.onSave(value, base.updatedAt);
          if (saved.kind === "changed" && saved.note) setBase(saved.note);
          return saved.kind === "saved";
        }}
      />
    </SettingListItem>
  );
}

function AddNote(props: { placeholder: string; onAdd(text: string): Promise<boolean> }) {
  const [text, setText] = useState("");
  return (
    <div data-setting-slot="" className="flex min-h-(--setting-row-height) items-center gap-2">
      <NoteField
        value={text}
        onChange={setText}
        label={props.placeholder}
        placeholder={props.placeholder}
        action="Add"
        onSubmit={async (value) => {
          const added = await props.onAdd(value);
          if (added) setText("");
          return added;
        }}
      />
    </div>
  );
}

/** One line of text with its action: Enter does it, Escape gives up (`onDone`, when given). */
function NoteField(props: {
  value: string;
  onChange(text: string): void;
  label: string;
  placeholder?: string;
  action: "Save" | "Add";
  onSubmit(text: string): Promise<boolean>;
  onDone?(): void;
}) {
  const [saving, setSaving] = useState(false);
  const ready = props.value.trim() !== "" && !saving;
  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    const done = await props.onSubmit(props.value.trim());
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
        value={props.value}
        maxLength={spadeNoteMax}
        placeholder={props.placeholder}
        autoFocus={props.onDone !== undefined}
        onChange={(event) => props.onChange(event.target.value)}
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
