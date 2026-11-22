import type { ContentPart } from "@ace/protocol";
import { formatCodeAnnotations, readCodeAnnotations, type CodeAnnotation } from "@ace/ui-core";

/*
 * The code notes of the open thread's next message: ranges the person pinned a note to in the
 * phone's editor. The phone owns them (they move with every keystroke in its editor, and outlast
 * a visit to the thread) and hands the session the whole list whenever it changes; on send they
 * become the `<code_annotations>` block after the person's words (`formatCodeAnnotations` in
 * `@ace/ui-core`, as the web's draft sends them), and the phone is told which ones went.
 */

/** What `send` takes from the draft's code notes. */
export interface CodeNotesHandOff {
  part: ContentPart;
  /** The notes the block holds: only these leave the phone's draft once the message is saved. */
  ids: string[];
}

export class ThreadCodeNotes {
  #notes: CodeAnnotation[] = [];
  /** `key` names the send, so each one's word reaches the phone, even after another visit's. */
  readonly #emit: (key: string, patch: Record<string, unknown>) => void;
  constructor(emit: (key: string, patch: Record<string, unknown>) => void) {
    this.#emit = emit;
  }
  get count(): number {
    return this.#notes.length;
  }
  /**
   * The phone's list, read one by one: an unreadable note is dropped, never the rest, and the
   * others are numbered 1…n in the phone's order, as the block names them.
   */
  set(values: readonly unknown[]): void {
    const notes = readCodeAnnotations(values);
    for (const [index, note] of notes.entries()) note.number = index + 1;
    this.#notes = notes;
  }
  handOff(): CodeNotesHandOff | undefined {
    const block = formatCodeAnnotations(this.#notes);
    if (!block) return undefined;
    return {
      part: { type: "text", text: `\n\n${block}` },
      ids: this.#notes.map((note) => note.id),
    };
  }
  /** The message went: the phone drops these notes; any made since stay for the next one. */
  sent(handOff: CodeNotesHandOff): void {
    const gone = new Set(handOff.ids);
    this.#notes = this.#notes.filter((note) => !gone.has(note.id));
    this.#emit(handOff.ids[0] ?? "", { type: "thread.codeSent", ids: handOff.ids });
  }
}

/** The person's words, then the notes' block. */
export function withCodeNotes(
  input: ContentPart[],
  handOff: CodeNotesHandOff | undefined,
): ContentPart[] {
  return handOff ? [...input, handOff.part] : input;
}

/** The block as words, for a message that takes one string (a new thread's first). */
export function codeText(handOff: CodeNotesHandOff): string {
  return handOff.part.type === "text" ? handOff.part.text : "";
}
