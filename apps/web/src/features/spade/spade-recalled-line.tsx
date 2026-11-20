import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { deleteNote } from "./spade-notes-api.ts";
import { SpadeProvenanceDialog } from "./spade-provenance.tsx";
import { readProvenance } from "./spade-provenance-api.ts";

/** "1 of your notes", "3 of its notes". */
const counted = (count: number) => (count === 1 ? "a note" : `${count} notes`);

/**
 * Under a finished reply: the notes Spade recalled for the message it answered (ADR 0128), as
 * one quiet line ("Had 2 notes in mind") that opens to each; a note opens where it's from, with
 * Forget this and Correct this. A note forgotten since reads as gone.
 */
export function SpadeRecalledLine(props: {
  notes: readonly string[];
  bot: string;
  onCorrect(): void;
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState<string>();
  const client = useSpadeClient();
  return (
    <div className="ml-1.5 flex min-w-0 max-w-[64ch] flex-col">
      <Disclosure
        summary={<span className="truncate">Had {counted(props.notes.length)} in mind</span>}
        summaryClassName="h-7 rounded-full px-2 text-ui"
        className="min-w-0 max-w-full"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        {open && (
          <ul
            aria-label="Notes it had in mind"
            className="mt-0.5 mb-1 ml-3.5 flex flex-col gap-1 border-l border-border pl-3.5"
          >
            {props.notes.map((id) => (
              <RecalledNote key={id} id={id} onWhy={() => setWhy(id)} />
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
        onCorrect={props.onCorrect}
        onDone={() => setWhy(undefined)}
      />
    </div>
  );
}

function RecalledNote(props: { id: string; onWhy(): void }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const note = useQuery({
    queryKey: ["spade", "provenance", machine, "note", props.id],
    queryFn: ({ signal }) => readProvenance(client, { kind: "note", id: props.id }, signal),
    retry: false,
  });
  if (note.isError)
    return <li className="text-ui text-subtle-foreground">A note forgotten since</li>;
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
