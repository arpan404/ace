import { z } from "zod";

/**
 * A short fact about a project that every thread and provider should know ("tests use
 * `bun run test`, never `bun test`"). Stored in ace's database, never in the repository.
 * Agents add and retire notes; the person sees and edits them in Edit project.
 */
export const ProjectNote = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  /** The thread whose agent wrote it; absent when the person wrote or last edited it. */
  threadId: z.string().min(1).max(256).optional(),
  createdAt: z.number().int().nonnegative(),
});
export type ProjectNote = z.infer<typeof ProjectNote>;
export const maxProjectNotes = 50;
/** A note as Edit project saves it: an existing note keeps its id; a new one has none. */
export const ProjectNoteEdit = z.object({
  id: z.string().min(1).max(64).optional(),
  text: z.string().min(1).max(500),
});
export type ProjectNoteEdit = z.infer<typeof ProjectNoteEdit>;
