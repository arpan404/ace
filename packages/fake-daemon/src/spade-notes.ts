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
  /** Extracted at compaction from untrusted content; the bot doesn't see it until kept. */
  suggested: boolean;
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
      suggested: false,
      created_at: this.now(),
      updated_at: this.now(),
      last_used_at: null,
      ...fields,
    };
    this.notes.push(note);
    return note;
  }

  /** A note compaction suggested from untrusted content, waiting for the person to keep it. */
  suggest(fields: Partial<FakeSpadeNote> & { text: string }): FakeSpadeNote {
    return this.add({ source: "compaction", ...fields, suggested: true });
  }

  /** Rewrites a note as a bot's memory tool would, moving its `updated_at` on. */
  rewrite(id: string, text: string): FakeSpadeNote {
    const note = this.notes.find((candidate) => candidate.id === id);
    if (!note) throw new Error(`No note ${id}.`);
    note.text = text;
    note.updated_at = this.later(note);
    return note;
  }

  /** Now, or just after the note's last change when the clock hasn't moved. */
  private later(note: FakeSpadeNote) {
    return Math.max(this.now(), note.updated_at + 1);
  }

  /** `/v1/agents/{agent}/notes` (agent set) or `/v1/notes[/{id}]`. */
  route(method: string, agent: string | null, id: string | undefined, body: unknown, sub?: string) {
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
      const same = this.notes.find((note) => note.agent === agent && note.text === text);
      if (same) return answer(same);
      return answer(this.add({ text, agent, scope: agent ? "agent" : "shared" }), 201);
    }
    const note = this.notes.find((candidate) => candidate.id === id);
    if (!note || agent) return problem(404, "No such note.");
    if (method === "PATCH") {
      if (!text) return problem(400, "A note needs 1 to 500 characters.");
      const seen = seenAt(body);
      if (seen !== undefined && seen !== note.updated_at)
        return answer({ error: "The note changed since you read it.", note }, 409);
      note.text = text;
      note.updated_at = this.later(note);
      return answer(note);
    }
    if (method === "POST" && sub === "accept") {
      note.suggested = false;
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

function seenAt(body: unknown): number | undefined {
  return typeof body === "object" &&
    body !== null &&
    "updated_at" in body &&
    typeof body.updated_at === "number"
    ? body.updated_at
    : undefined;
}

function clean(body: unknown): string | undefined {
  const text =
    typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
      ? body.text.replaceAll(/\s*\n\s*/g, " ").trim()
      : "";
  return text && text.length <= 500 ? text : undefined;
}
