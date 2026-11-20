import { spadePastTime, spadeUndoSummary, type SpadeUndoPreview } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useNow } from "@/lib/time.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { personZone } from "./spade-routines-api.ts";
import { botSecurityKey, readUndoPreview, restoreCheckpoint } from "./spade-security-api.ts";
import { SpadeRequestError } from "./spade-requests.ts";

/** What the person asked to undo: a step, or a turn from its first file-changing step. */
export interface UndoAsk {
  /** The step's position in the bot's conversation. */
  from: number;
  /** What it covers, for the title: "this reply's changes", "this change". */
  what: string;
  /** Steps undo leaves as they are ("Sent an email"), said before anything changes. */
  stays: readonly string[];
}

/** Why Spade refused an undo, in the person's words. */
function refused(name: string, error: unknown): string {
  if (error instanceof SpadeRequestError && error.status === 409) {
    const message = error.message;
    if (message.includes("services")) return `${name}'s services are running. Stop them first.`;
    if (message.includes("being restored")) return "An undo is already running.";
    return `${name} is working. Stop it first, then undo.`;
  }
  if (error instanceof SpadeRequestError && error.status === 404)
    return "There's no checkpoint from before this anymore, so it can't be undone.";
  return error instanceof Error && error.message ? error.message : "Try again.";
}

function Paths(props: { label: string; paths: readonly string[] }) {
  if (!props.paths.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-xl bg-chat-well px-3 py-2">
        {props.paths.map((path) => (
          <li key={path} className="truncate font-mono text-xs leading-5" title={path}>
            {path}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Undo in the conversation (ADR 0167): first what putting the checkpoint back would do (files
 * that go back, go, and come back) and what stays as it is, then Undo. Nothing changes until the
 * person presses it; a bot still working is said in words, and the bot is told afterwards.
 */
export function SpadeUndoDialog(props: {
  bot: { id: string; name: string };
  ask: UndoAsk | undefined;
  onDone(): void;
}) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const now = useNow();
  const { ask } = props;
  const [problem, setProblem] = useState<string>();
  const [undoing, setUndoing] = useState(false);
  const [done, setDone] = useState<string>();
  const preview = useQuery({
    queryKey: ["spade", "undo", machine, props.bot.id, ask?.from],
    queryFn: ({ signal }) => readUndoPreview(client, props.bot.id, ask?.from ?? 0, signal),
    enabled: ask !== undefined,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const close = () => {
    setProblem(undefined);
    setDone(undefined);
    props.onDone();
  };
  const undo = async (shown: SpadeUndoPreview) => {
    setUndoing(true);
    setProblem(undefined);
    try {
      await restoreCheckpoint(client, props.bot.id, shown.checkpoint.id);
      setDone(`Undone. ${props.bot.name} knows its files went back.`);
      await cache.invalidateQueries({
        queryKey: botSecurityKey(machine, props.bot.id, "checkpoints"),
      });
    } catch (error) {
      setProblem(refused(props.bot.name, error));
    } finally {
      setUndoing(false);
    }
  };
  const shown = preview.data;
  const empty = shown && !shown.changed.length && !shown.added.length && !shown.deleted.length;
  const when = shown
    ? spadePastTime(shown.checkpoint.at, { now, timeZone: personZone() })
    : undefined;
  return (
    <Dialog open={ask !== undefined} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Undo {ask?.what ?? "these changes"}?</DialogTitle>
          <DialogDescription>
            {preview.isPending
              ? "Comparing its files with the checkpoint…"
              : preview.isError
                ? refused(props.bot.name, preview.error)
                : shown && when
                  ? `${props.bot.name}'s files go back to how they were at ${when}: ${spadeUndoSummary(shown).toLowerCase()}. Anything changed after that goes back too.`
                  : undefined}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {shown && (
            <>
              <Paths label="Go back to how they were" paths={shown.changed} />
              <Paths label="Made since, removed" paths={shown.added} />
              <Paths label="Removed since, back again" paths={shown.deleted} />
              {shown.more > 0 && (
                <p className="text-xs text-muted-foreground">And {shown.more} more files.</p>
              )}
            </>
          )}
          {ask && ask.stays.length > 0 && (
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-foreground">Undo can't take these back</h3>
              <ul className="flex flex-col text-ui text-foreground">
                {[...new Set(ask.stays)].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
          {done && <p className="text-ui text-foreground">{done}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button
              variant="primary"
              disabled={!shown || empty || undoing}
              onClick={() => shown && void undo(shown)}
            >
              {undoing ? "Undoing…" : empty ? "Nothing to undo" : "Undo"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
