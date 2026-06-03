import * as Schema from "effect/Schema";

import { randomUUID } from "~/lib/utils";

export const SCRATCH_PAD_STORAGE_KEY = "ace:scratch-pads:v1";
export const OPEN_SCRATCH_PAD_EVENT = "ace:open_scratch_pad";

export interface OpenScratchPadDetail {
  noteId?: string;
}

export const ScratchPadNoteSchema = Schema.Struct({
  body: Schema.String,
  createdAt: Schema.Number,
  id: Schema.String,
  imageDataUrl: Schema.NullOr(Schema.String),
  title: Schema.String,
  updatedAt: Schema.Number,
});

export const ScratchPadCollectionSchema = Schema.Struct({
  activeNoteId: Schema.NullOr(Schema.String),
  notes: Schema.Array(ScratchPadNoteSchema),
});

export type ScratchPadNote = typeof ScratchPadNoteSchema.Type;
export type ScratchPadCollection = typeof ScratchPadCollectionSchema.Type;

export const EMPTY_SCRATCH_PAD_COLLECTION: ScratchPadCollection = {
  activeNoteId: null,
  notes: [],
};

export function createScratchPadNote(input?: Partial<Pick<ScratchPadNote, "body" | "title">>) {
  const now = Date.now();
  return {
    body: input?.body ?? "",
    createdAt: now,
    id: `note-${randomUUID()}`,
    imageDataUrl: null,
    title: input?.title ?? "Untitled note",
    updatedAt: now,
  } satisfies ScratchPadNote;
}

export function resolveScratchPadTitle(note: ScratchPadNote): string {
  const title = note.title.trim();
  if (title) return title;
  const firstLine = note.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? "Untitled note";
}

export function resolveScratchPadPreview(note: ScratchPadNote): string {
  const body = note.body.trim().replace(/\s+/g, " ");
  if (body) return body;
  return note.imageDataUrl ? "Drawing" : "Empty note";
}

export function openScratchPadDialog(noteId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenScratchPadDetail>(OPEN_SCRATCH_PAD_EVENT, {
      detail: noteId ? { noteId } : {},
    }),
  );
}
