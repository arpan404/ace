import {
  maxProjectNotes,
  type ProjectNote,
  type ProjectNoteEdit,
  type ThreadId,
} from "@ace/protocol";

/** Pure note edits. Storage owns persistence; these decide the resulting list. */
export function addNote(
  notes: readonly ProjectNote[],
  text: string,
  author: ThreadId | undefined,
  at: number,
  id: string,
): ProjectNote[] {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!clean) throw new Error("Empty note");
  // The same fact twice is one note.
  if (notes.some((note) => note.text === clean)) return [...notes];
  if (notes.length >= maxProjectNotes) throw new Error("Project note limit");
  return [...notes, { id, text: clean, ...(author ? { threadId: author } : {}), createdAt: at }];
}

export function retireNote(notes: readonly ProjectNote[], id: string): ProjectNote[] | undefined {
  const kept = notes.filter((note) => note.id !== id);
  return kept.length === notes.length ? undefined : kept;
}

/**
 * The person's edit from Edit project: the given order and text win. An unchanged note keeps
 * its author; edited text becomes the person's. Notes left out are removed.
 */
export function applyNoteEdits(
  notes: readonly ProjectNote[],
  edits: readonly ProjectNoteEdit[],
  at: number,
  id: () => string,
): ProjectNote[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return edits.slice(0, maxProjectNotes).flatMap((raw) => {
    const edit = { ...raw, text: raw.text.replace(/\s+/g, " ").trim() };
    if (!edit.text) return [];
    const existing = edit.id === undefined ? undefined : byId.get(edit.id);
    if (existing && existing.text === edit.text) return [existing];
    return [{ id: existing?.id ?? id(), text: edit.text, createdAt: existing?.createdAt ?? at }];
  });
}
