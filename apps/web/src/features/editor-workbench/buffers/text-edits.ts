import type { Change, EditorDocument, LineChange, MergeChunk } from "@ace/editor";
import type { Answer } from "./types.ts";

/*
 * Pure helpers for landing text the registry produced (a reload, a merge) in a document, and
 * for assembling a conflict's answers.
 */

/** The merged text once every conflicting block has an answer, in block order. */
export function resolveConflict(
  chunks: readonly MergeChunk[],
  answers: readonly (Answer | undefined)[],
): string {
  let block = 0;
  let text = "";
  for (const chunk of chunks) {
    if (chunk.kind === "clean") text += chunk.text;
    else text += answers[block++] === "theirs" ? chunk.theirs : chunk.mine;
  }
  return text;
}

/** How many blocks of a merge conflict. */
export function conflictCount(chunks: readonly MergeChunk[]): number {
  return chunks.reduce((count, chunk) => count + (chunk.kind === "conflict" ? 1 : 0), 0);
}

/**
 * Applies whole-line changes (from `lineChanges` on the document's own text) as one transaction
 * and one undo step. Carets outside the changed blocks keep their place on their text.
 */
export function applyLineChanges(doc: EditorDocument, changes: readonly LineChange[]): void {
  if (changes.length === 0) return;
  const lines = doc.lenLines();
  const last = lines - 1;
  const at = (line: number) =>
    line < lines ? { line, column: 0 } : { line: last, column: doc.line(last).length };
  const transaction: Change[] = changes.map((change) => ({
    range: { start: at(change.start), end: at(change.end) },
    text: change.text,
  }));
  doc.commit();
  doc.apply(transaction);
  doc.commit();
}

/** UTF-8 bytes of `text`, the unit the memory cap counts, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}
