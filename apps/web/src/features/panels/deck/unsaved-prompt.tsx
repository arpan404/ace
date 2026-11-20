import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";

/*
 * The Deck's questions before unsaved text could be dropped (spec 46, 48): "Save changes to
 * store.ts?" with Save, Don't save and Cancel, one dialog for several files; and, when a save
 * meets an agent's change, "Replace Claude Code's changes in places.ts?" with Merge as the
 * default. Asked from anywhere (a tab's ×, closing the Deck tab, a save); drawn once per screen
 * by the Deck kind's overlay. Escape and a click outside are Cancel.
 */

export type UnsavedAnswer = "save" | "discard" | "cancel";
export type ReplaceAnswer = "merge" | "replace" | "cancel";

/** Every question can be answered Cancel; each kind takes its own other answers. */
type Question = (
  | { kind: "unsaved"; paths: readonly string[] }
  | { kind: "replace"; path: string; who: string | undefined }
) & { answer(value: string): void };

let current: Question | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

const fileName = (path: string) => path.split("/").at(-1) ?? path;

function ask(question: Question): void {
  // A newer question replaces an older one, which counts as Cancel.
  const previous = current;
  current = question;
  previous?.answer("cancel");
  emit();
}

/** The answer among `choices` (the first, Cancel, for anything else). */
const pick =
  <T extends string>(choices: readonly [T, ...T[]], resolve: (value: T) => void) =>
  (value: string) =>
    resolve(choices.find((choice) => choice === value) ?? choices[0]);

/** Ask whether to save files before they close. */
export function askUnsaved(paths: readonly string[]): Promise<UnsavedAnswer> {
  return new Promise((resolve) =>
    ask({ kind: "unsaved", paths, answer: pick(["cancel", "save", "discard"], resolve) }),
  );
}

/** A save met `who`'s change on disk (nobody named: "the disk"): merge, write over it, or not. */
export function askReplace(path: string, who: string | undefined): Promise<ReplaceAnswer> {
  return new Promise((resolve) =>
    ask({ kind: "replace", path, who, answer: pick(["cancel", "merge", "replace"], resolve) }),
  );
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The person answered the question showing (outside React: it reads and clears the queue). */
function respond(value: string): void {
  const asked = current;
  current = undefined;
  emit();
  asked?.answer(value);
}

export function UnsavedPrompt() {
  const question = useSyncExternalStore(subscribe, () => current);
  // Kept after an answer so the card doesn't empty while it fades out.
  const [shown, setShown] = useState(question);
  if (question && question !== shown) setShown(question);
  useEffect(() => () => current?.answer("cancel"), []);
  const primary = useRef<HTMLButtonElement>(null);
  const card = question ?? shown;
  return (
    <Dialog open={question !== undefined} onOpenChange={(open) => !open && respond("cancel")}>
      <DialogContent initialFocus={primary} showCloseButton={false}>
        {card?.kind === "unsaved" && (
          <>
            <DialogHeader>
              <DialogTitle>
                {card.paths.length === 1
                  ? `Save changes to ${fileName(card.paths[0] ?? "")}?`
                  : `Save changes to ${card.paths.length} files?`}
              </DialogTitle>
              <DialogDescription>
                {card.paths.length === 1 ? (
                  "Your changes are lost if you don't save them."
                ) : (
                  <span className="flex flex-col">
                    {card.paths.map((path) => (
                      <span key={path} className="truncate font-mono text-xs">
                        {path}
                      </span>
                    ))}
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => respond("cancel")}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={() => respond("discard")}>
                Don't save
              </Button>
              <Button ref={primary} onClick={() => respond("save")}>
                Save
              </Button>
            </DialogFooter>
          </>
        )}
        {card?.kind === "replace" && (
          <>
            <DialogHeader>
              <DialogTitle>
                {card.who
                  ? `Replace ${card.who}'s changes in ${fileName(card.path)}?`
                  : `${fileName(card.path)} changed on disk. Replace it?`}
              </DialogTitle>
              <DialogDescription>
                Merge keeps both. Replace writes your version over theirs.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => respond("cancel")}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={() => respond("replace")}>
                Replace
              </Button>
              <Button ref={primary} onClick={() => respond("merge")}>
                Merge
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
