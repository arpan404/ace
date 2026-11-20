import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { deleteNote, editNote, notesKey } from "./spade-notes-api.ts";
import { SpadeProvenanceDialog } from "./spade-provenance.tsx";
import { readProvenance } from "./spade-provenance-api.ts";

/** "a note", "3 notes". */
const counted = (count: number) => (count === 1 ? "a note" : `${count} notes`);

const provenanceKey = (machine: string, id: string) =>
  ["spade", "provenance", machine, "note", id] as const;

/**
 * Under a finished reply: the notes Spade recalled for the message it answered (ADR 0128), as
 * one quiet line ("Had 2 notes in mind") that opens to each; a note opens where it's from, with
 * Forget this and Correct this. Correct this opens that same note right here, its words ready to
 * change. A note forgotten since reads as gone.
 */
export function SpadeRecalledLine(props: { notes: readonly string[]; bot: string }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState<string>();
  const [correcting, setCorrecting] = useState<string>();
  const client = useSpadeClient();
  return (
    <div className="ml-1.5 flex min-w-0 max-w-[64ch] flex-col">
      <Disclosure
        summary={<span className="truncate">Had {counted(props.notes.length)} in mind</span>}
        summaryClassName="h-7 rounded-full px-2 text-ui"
        className="min-w-0 max-w-full"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        {open && (
          <ul
            aria-label="Notes it had in mind"
            className="mt-0.5 mb-1 ml-3.5 flex flex-col gap-1 border-l border-border pl-3.5"
          >
            {props.notes.map((id) => (
              <RecalledNote
                key={id}
                id={id}
                correcting={correcting === id}
                onWhy={() => setWhy(id)}
                onDone={() => setCorrecting(undefined)}
              />
            ))}
          </ul>
        )}
      </Disclosure>
      <SpadeProvenanceDialog
        bot={props.bot}
        of={why ? { kind: "note", id: why } : undefined}
        onForget={async () => {
          if (why) await deleteNote(client, why);
        }}
        onCorrect={() => {
          setOpen(true);
          setCorrecting(why);
        }}
        onDone={() => setWhy(undefined)}
      />
    </div>
  );
}

function RecalledNote(props: { id: string; correcting: boolean; onWhy(): void; onDone(): void }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const note = useQuery({
    queryKey: provenanceKey(machine, props.id),
    queryFn: ({ signal }) => readProvenance(client, { kind: "note", id: props.id }, signal),
    retry: false,
  });
  if (note.isError)
    return <li className="text-ui text-subtle-foreground">A note forgotten since</li>;
  if (props.correcting && note.data)
    return <CorrectNote id={props.id} text={note.data.text} onDone={props.onDone} />;
  return (
    <li>
      <button
        type="button"
        onClick={props.onWhy}
        aria-label={note.data ? `Where it's from: ${note.data.text}` : "Where it's from"}
        className="rounded-sm text-left text-ui text-muted-foreground focus-ring hover:text-foreground"
      >
        {note.data?.text ?? "…"}
      </button>
    </li>
  );
}

/** One recalled note open to correct, where it was listed: Save rewrites it, Cancel leaves it. */
function CorrectNote(props: { id: string; text: string; onDone(): void }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const fieldId = useId();
  const [text, setText] = useState(props.text);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      await editNote(client, props.id, text.trim());
      await Promise.all([
        cache.invalidateQueries({ queryKey: provenanceKey(machine, props.id) }),
        cache.invalidateQueries({ queryKey: notesKey }),
      ]);
      props.onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="flex flex-col gap-1.5 py-1">
      <label htmlFor={fieldId} className="sr-only">
        Correct the note
      </label>
      <Textarea
        id={fieldId}
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="min-h-16"
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={saving || !text.trim() || text.trim() === props.text}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </li>
  );
}
