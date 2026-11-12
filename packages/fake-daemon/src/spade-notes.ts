import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Spade's notes (ADR 0128) for the fake API: a bot's own and the shared ones, in Spade's JSON,
 * with its limits (1 to 500 characters, 1,000 a scope) and its refusals.
 */

export interface FakeSpadeNote {
  id: string;
  text: string;
  scope: "agent" | "shared";
  agent: string | null;
  source: "person" | "bot" | "compaction";
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const answer = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => answer({ error }, status);

export class FakeSpadeNotes {
  notes: FakeSpadeNote[] = [];
  private sequence = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Adds a note as a bot or the person would have saved it; returns it. */
  add(fields: Partial<FakeSpadeNote> & { text: string }): FakeSpadeNote {
    const note: FakeSpadeNote = {
      id: `n_${++this.sequence}`,
      scope: fields.agent ? "agent" : "shared",
      agent: null,
      source: "person",
      created_at: this.now(),
      updated_at: this.now(),
      last_used_at: null,
      ...fields,
    };
    this.notes.push(note);
    return note;
  }

  /** `/v1/agents/{agent}/notes` (agent set) or `/v1/notes[/{id}]`. */
  route(method: string, agent: string | null, id: string | undefined, body: unknown) {
    const text = clean(body);
    if (!id && method === "GET")
      return answer({
        notes: this.notes
          .filter((note) => note.agent === agent)
          .toSorted((a, b) => b.updated_at - a.updated_at),
      });
    if (!id && method === "POST") {
      if (!text) return problem(400, "A note needs 1 to 500 characters.");
      if (this.notes.filter((note) => note.agent === agent).length >= 1000)
        return problem(409, "This scope already holds 1,000 notes.");
      return answer(this.add({ text, agent, scope: agent ? "agent" : "shared" }), 201);
    }
    const note = this.notes.find((candidate) => candidate.id === id);
    if (!note || agent) return problem(404, "No such note.");
    if (method === "PATCH") {
      if (!text) return problem(400, "A note needs 1 to 500 characters.");
      note.text = text;
      note.updated_at = this.now();
      return answer(note);
    }
    if (method === "DELETE") {
      this.notes = this.notes.filter((candidate) => candidate !== note);
      return { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  /** A deleted bot's notes go with it. */
  forget(agent: string) {
    this.notes = this.notes.filter((note) => note.agent !== agent);
  }
}

function clean(body: unknown): string | undefined {
  const text =
    typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
      ? body.text.replaceAll(/\s*\n\s*/g, " ").trim()
      : "";
  return text && text.length <= 500 ? text : undefined;
}
