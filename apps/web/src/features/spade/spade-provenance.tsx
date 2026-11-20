import {
  spadeLearnedCount,
  spadeProvenanceLines,
  type SpadeLearnedSource,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
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
import { knowledgeKey } from "./spade-knowledge-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { notesKey } from "./spade-notes-api.ts";
import { ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import {
  forgetSource,
  readLearned,
  readProvenance,
  type ProvenanceOf,
} from "./spade-provenance-api.ts";
import { personZone } from "./spade-routines-api.ts";

/** Every "learned from" read; a bot's under `[...learnedKey, machine, bot]`. */
export const learnedKey = ["spade", "learned"] as const;

/** After a forget: the notes, the pages and the sources are read again. */
/** A source's label inside a sentence: "your conversation with Trips", not "Your …". */
const inline = (label: string) => label.replace(/^Your /, "your ");

function useForgotten() {
  const cache = useQueryClient();
  return () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: notesKey }),
      cache.invalidateQueries({ queryKey: knowledgeKey }),
      cache.invalidateQueries({ queryKey: learnedKey }),
    ]);
}

/** "Forgot 2 notes and 1 page from example.com." */
function forgotWords(gone: { notes: number; entries: number }, label: string): string {
  if (!gone.notes && !gone.entries) return `Nothing left from ${inline(label)}.`;
  return `Forgot ${spadeLearnedCount({ notes: gone.notes, entries: gone.entries })} from ${inline(label)}.`;
}

/**
 * "Why do you think that?": where a note or page came from (who said it, the conversation and
 * the message it answered, what it read, its trust and when), with Forget this, Correct this,
 * and forgetting everything from one of its sources.
 */
export function SpadeProvenanceDialog(props: {
  /** The bot whose memory it is, for forgetting by source. */
  bot: string | undefined;
  of: ProvenanceOf | undefined;
  onForget(): Promise<void> | void;
  onCorrect(): void;
  onDone(): void;
}) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const forgotten = useForgotten();
  const [said, setSaid] = useState<string>();
  const [confirming, setConfirming] = useState<Confirming>();
  const why = useQuery({
    queryKey: ["spade", "provenance", machine, props.of?.kind, props.of?.id],
    queryFn: ({ signal }) => readProvenance(client, props.of ?? { kind: "note", id: "" }, signal),
    enabled: props.of !== undefined,
    retry: false,
  });
  const close = () => {
    setSaid(undefined);
    props.onDone();
  };
  const shown = why.data;
  const lines = shown ? spadeProvenanceLines(shown, { now, timeZone: personZone() }) : [];
  const forgetAll = (source: { key: string; label: string }) => {
    const bot = props.bot;
    if (!bot) return;
    setConfirming({
      title: `Forget everything learned from ${source.label}?`,
      body: "Every note and page that came from there goes. What you wrote yourself stays.",
      confirm: "Forget all of it",
      run: () =>
        void forgetSource(client, bot, source.key)
          .then(async (gone) => {
            await forgotten();
            setSaid(forgotWords(gone, source.label));
          })
          .catch((error: unknown) =>
            setSaid(error instanceof Error ? error.message : "Try again."),
          ),
    });
  };
  return (
    <>
      <Dialog open={props.of !== undefined} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Where it's from</DialogTitle>
            <DialogDescription>
              {why.isPending
                ? "Looking it up…"
                : why.isError
                  ? "Spade couldn't say where this came from."
                  : shown?.text}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {lines.length > 0 && (
              <ul className="flex flex-col gap-1 text-ui text-foreground">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {props.bot && shown && shown.sources.length > 0 && (
              <section className="flex flex-col gap-0.5">
                {shown.sources.map((source) => (
                  <Button
                    key={source.key}
                    variant="ghost"
                    className={`${rowPill} -ml-3 w-fit text-muted-foreground`}
                    onClick={() => forgetAll(source)}
                  >
                    Forget everything from {inline(source.label)}
                  </Button>
                ))}
              </section>
            )}
            {said && <p className="text-ui text-foreground">{said}</p>}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={!shown}
              onClick={() =>
                void Promise.resolve(props.onForget()).then(async () => {
                  await forgotten();
                  close();
                })
              }
            >
              Forget this
            </Button>
            <Button
              variant="secondary"
              disabled={!shown}
              onClick={() => {
                close();
                props.onCorrect();
              }}
            >
              Correct this
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}

/**
 * Learned from, a section of Library: each source a bot's notes and pages came from (a
 * conversation, a site, an app, an import), counted, with "Forget all" behind a confirm. The
 * person's own words aren't listed: nothing to forget them by. None, no section.
 */
export function LibraryLearnedFrom(props: { bot: { id: string; name: string } }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const forgotten = useForgotten();
  const [confirming, setConfirming] = useState<Confirming>();
  const [said, setSaid] = useState<string>();
  const learned = useQuery({
    queryKey: [...learnedKey, machine, props.bot.id],
    queryFn: ({ signal }) => readLearned(client, props.bot.id, signal),
    retry: false,
  });
  const sources = learned.data ?? [];
  if (!sources.length && !said) return null;
  const ask = (source: SpadeLearnedSource) =>
    setConfirming({
      title: `Forget everything ${props.bot.name} learned from ${source.label}?`,
      body: `${spadeLearnedCount(source)} go. What you wrote yourself stays.`,
      confirm: "Forget all of it",
      run: () =>
        void forgetSource(client, props.bot.id, source.key)
          .then(async (gone) => {
            await forgotten();
            setSaid(forgotWords(gone, source.label));
          })
          .catch((error: unknown) =>
            setSaid(error instanceof Error ? error.message : "Try again."),
          ),
    });
  return (
    <ProfileSection label="Learned from">
      {sources.map((source) => (
        <SettingRow
          key={source.key}
          title={source.label}
          description={spadeLearnedCount(source)}
          density="compact"
          inline
        >
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Forget everything from ${inline(source.label)}`}
            className={rowPill}
            onClick={() => ask(source)}
          >
            Forget all
          </Button>
        </SettingRow>
      ))}
      {said && (
        <p data-setting-slot="" className="py-2 text-xs text-muted-foreground">
          {said}
        </p>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </ProfileSection>
  );
}
