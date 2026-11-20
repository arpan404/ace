import type { EditorDocument, MergeChunk, MergeResult } from "@ace/editor";
import type { Author } from "./attribution.ts";
import { conflictCount, resolveConflict } from "./text-edits.ts";
import type { Answer, Clash, MergePort, Theirs } from "./types.ts";

/*
 * Spec 46's Merge, as a loop over one buffer: merge the buffer with the disk from the base the
 * person started from, off the main thread, and land the result only if nothing moved while it
 * ran. Typing during the merge, or another disk change, simply runs it again with the newer text.
 */

/** The buffer's side of the loop. */
export interface ReconcileHost {
  doc(): EditorDocument | undefined;
  base(): Theirs | undefined;
  clash(): Clash | undefined;
  merge: MergePort;
  /** Puts merged text in the document by changed blocks; false if it moved meanwhile. */
  land(text: string): Promise<boolean>;
  /** Sets the clash; `mine` is the buffer text a conflict's blocks were cut from. */
  setClash(clash: Clash, mine?: string): void;
  /** The merge landed: `theirs` is the new base; `newer` a disk change that came meanwhile. */
  rebase(theirs: Theirs, text: string, newer: Theirs | undefined, by: Author): void;
}

/** Every block of a conflict answered, against the buffer text it was cut from. */
export interface Answered {
  chunks: readonly MergeChunk[];
  answers: readonly (Answer | undefined)[];
  mine: string;
}

/** Past this many reruns (someone typing through every merge) the notice comes back instead. */
const reruns = 20;

export async function reconcile(host: ReconcileHost, answered?: Answered): Promise<void> {
  let pending = answered;
  for (let run = 0; run < reruns; run++) {
    const clash = host.clash();
    const doc = host.doc();
    const base = host.base();
    if (!doc || !base || (clash?.kind !== "merging" && clash?.kind !== "conflict")) return;
    if (clash.kind === "conflict" && !pending) return;
    const { theirs, by } = clash;
    const mine = doc.text();
    const at = doc.version();
    let result: MergeResult;
    try {
      result = pending
        ? await rebaseAnswers(host.merge, pending, mine)
        : await host.merge.merge3(base.text, mine, theirs.text);
    } catch {
      host.setClash({ kind: "changed", theirs, by });
      return;
    }
    const now = host.clash();
    if (now !== clash) {
      // A newer disk version came while merging: merge again against it.
      if (now?.kind === "merging") continue;
      return;
    }
    if (doc.version() !== at || host.doc() !== doc) continue;
    if (!result.clean) {
      if (pending) {
        // Typing landed inside an answered block: ask again from a fresh merge.
        pending = undefined;
        host.setClash({ kind: "merging", theirs, by });
        continue;
      }
      const answers = Array.from({ length: conflictCount(result.chunks) }, () => undefined);
      host.setClash({ kind: "conflict", theirs, by, chunks: result.chunks, answers }, mine);
      return;
    }
    if (!(await host.land(result.text))) continue;
    const after = host.clash();
    const newer = after !== clash && after && "theirs" in after ? after.theirs : undefined;
    host.rebase(theirs, result.text, newer, by);
    return;
  }
  const last = host.clash();
  if (last && "theirs" in last)
    host.setClash({ kind: "changed", theirs: last.theirs, by: last.by });
}

/** The answered text, carried onto whatever was typed since the conflict was cut. */
async function rebaseAnswers(
  merge: MergePort,
  answered: Answered,
  mine: string,
): Promise<MergeResult> {
  const resolved = resolveConflict(answered.chunks, answered.answers);
  if (mine === answered.mine) return { clean: true, text: resolved, chunks: [] };
  return merge.merge3(answered.mine, mine, resolved);
}
