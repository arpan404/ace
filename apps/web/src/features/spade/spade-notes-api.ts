import { parseSpadeNote, parseSpadeNotes, type SpadeNote } from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's notes (ADR 0128, spade/docs/memory.md): a bot's own under `/v1/agents/{id}/notes`,
 * the shared "About you" ones under `/v1/notes`; either is changed or deleted by its id.
 */

/** Whose notes: one bot's own, or the shared ones every bot sees. */
export type SpadeNotesScope = { kind: "agent"; agent: string } | { kind: "shared" };

const listPath = (scope: SpadeNotesScope) =>
  scope.kind === "agent" ? `/v1/agents/${segment(scope.agent)}/notes` : "/v1/notes";

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

/** Newest change first; with `query`, ranked by how well each matches it. */
export async function readNotes(
  target: SpadeTarget,
  scope: SpadeNotesScope,
  options: { query?: string; signal?: AbortSignal | undefined } = {},
): Promise<SpadeNote[]> {
  const query = options.query?.trim();
  const path = query ? `${listPath(scope)}?q=${encodeURIComponent(query)}` : listPath(scope);
  return sure(parseSpadeNotes(await spadeHttp(target, "GET", path, options)), "notes");
}

export async function addNote(
  target: SpadeTarget,
  scope: SpadeNotesScope,
  text: string,
): Promise<SpadeNote> {
  const body = await spadeHttp(target, "POST", listPath(scope), { body: { text } });
  return sure(parseSpadeNote(body), "new note");
}

export async function editNote(target: SpadeTarget, id: string, text: string): Promise<SpadeNote> {
  const body = await spadeHttp(target, "PATCH", `/v1/notes/${segment(id)}`, { body: { text } });
  return sure(parseSpadeNote(body), "note");
}

export async function deleteNote(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/notes/${segment(id)}`);
}
