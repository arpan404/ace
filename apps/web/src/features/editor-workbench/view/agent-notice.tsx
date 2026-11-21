import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { ensureEditorReady } from "@/features/editor";
import { workerMerge, type MergePort } from "../buffers/index.ts";
import { clashWords, conflictWords } from "./clash-words.ts";
import { noticeClash, type EditorBuffers } from "./editor-buffers.ts";
import type { BufferSnapshot, Clash, TextBuffer } from "../buffers/index.ts";

/**
 * Spec 46: the moment the disk version moves under unsaved edits, one bar at the editor's foot
 * says in words who changed which lines while the person was editing which, and whether they
 * meet, with Merge and Compare. While comparing, it also answers for the whole file (Keep mine,
 * Take theirs) and leads back to the editor. Once Merge finds blocks both sides changed
 * differently, it counts the blocks still to answer (each is answered where it shows, in place
 * of the editor) and can answer all of them at once. It stays until an answer or a save clears
 * the registry's clash; Merge waits while one runs.
 */
export function AgentNotice(props: {
  snapshot: BufferSnapshot | undefined;
  buffer: TextBuffer | undefined;
  buffers: EditorBuffers;
  comparing: boolean;
  onMerge(): void;
  /** Unset: nothing to compare with. */
  onCompare?: (() => void) | undefined;
  onKeepMine(): void;
  onTakeTheirs(): void;
}) {
  const shown = noticeClash(props.snapshot);
  const clash = props.snapshot?.clash;
  const changer = clash && "by" in clash ? props.buffers.changer(clash.by) : undefined;
  const words = useClashWords(props.buffer, shown, changer?.name);
  if (clash?.kind === "conflict")
    return <ConflictBar clash={clash} buffer={props.buffer} changer={changer} />;
  if (!shown) return null;
  const busy = shown.kind === "merging";
  return (
    <div
      role="status"
      data-part="editor-notice"
      className="flex min-h-9 shrink-0 items-center gap-2 border-t border-border py-1 pr-2.5 pl-3.5 text-ui text-foreground"
    >
      {changer?.provider && <ProviderIcon provider={changer.provider} size={14} decorative />}
      <span className="min-w-0 flex-1 truncate" title={words}>
        {words ??
          (changer ? `${changer.name} also changed this file.` : "This file changed on disk.")}
      </span>
      <Button size="sm" disabled={busy} onClick={props.onMerge}>
        Merge
      </Button>
      {props.comparing && (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onKeepMine}>
            Keep mine
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onTakeTheirs}>
            Take theirs
          </Button>
        </>
      )}
      {props.onCompare && (
        <Button size="sm" variant="ghost" onClick={props.onCompare}>
          {props.comparing ? "Back to editor" : "Compare"}
        </Button>
      )}
    </div>
  );
}

/** The bar while conflicting blocks wait for answers. */
function ConflictBar(props: {
  clash: Extract<Clash, { kind: "conflict" }>;
  buffer: TextBuffer | undefined;
  changer: ReturnType<EditorBuffers["changer"]>;
}) {
  const { clash, buffer, changer } = props;
  const answered = clash.answers.filter((answer) => answer !== undefined).length;
  const all = (answer: "mine" | "theirs") => {
    for (const [index, given] of clash.answers.entries())
      if (given !== answer) void buffer?.answer(index, answer);
  };
  return (
    <div
      role="status"
      data-part="editor-notice"
      className="flex min-h-9 shrink-0 items-center gap-2 border-t border-border py-1 pr-2.5 pl-3.5 text-ui text-foreground"
    >
      {changer?.provider && <ProviderIcon provider={changer.provider} size={14} decorative />}
      <span className="min-w-0 flex-1 truncate">
        {conflictWords(changer?.name, clash.answers.length, answered)}
      </span>
      <Button size="sm" variant="ghost" onClick={() => all("mine")}>
        Keep all mine
      </Button>
      <Button size="sm" variant="ghost" onClick={() => all("theirs")}>
        Take all theirs
      </Button>
    </div>
  );
}

let port: MergePort | undefined;

/** The bar's words for a clash, worked out off the main thread once per disk version. */
function useClashWords(
  buffer: TextBuffer | undefined,
  clash: ReturnType<typeof noticeClash>,
  who: string | undefined,
): string | undefined {
  const [words, setWords] = useState<{ version: string; text: string }>();
  const theirs = clash?.theirs;
  useEffect(() => {
    const base = buffer?.baseText();
    const mine = buffer?.document()?.text();
    if (!theirs || base === undefined || mine === undefined) return;
    let live = true;
    port ??= workerMerge(ensureEditorReady);
    void Promise.all([port.lineChanges(base, theirs.text), port.lineChanges(base, mine)]).then(
      ([fromTheirs, fromMine]) => {
        if (live)
          setWords({
            version: theirs.version,
            text: clashWords({ who, theirs: fromTheirs, mine: fromMine }),
          });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [buffer, theirs, who]);
  return theirs && words?.version === theirs.version ? words.text : undefined;
}
