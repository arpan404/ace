import * as Schema from "effect/Schema";

import { randomUUID } from "~/lib/utils";

export const SCRATCH_PAD_STORAGE_KEY = "ace:scratch-pads:v1";

const ScratchPadNoteSchema = Schema.Struct({
  body: Schema.String,
  createdAt: Schema.Number,
  id: Schema.String,
  imageDataUrl: Schema.NullOr(Schema.String),
  threadId: Schema.optional(Schema.String),
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

export function createScratchPadNote(
  input?: Partial<Pick<ScratchPadNote, "body" | "threadId" | "title">>,
) {
  const now = Date.now();
  return {
    body: input?.body ?? "",
    createdAt: now,
    id: `note-${randomUUID()}`,
    imageDataUrl: null,
    ...(input?.threadId ? { threadId: input.threadId } : {}),
    title: input?.title ?? "Untitled note",
    updatedAt: now,
  } satisfies ScratchPadNote;
}
