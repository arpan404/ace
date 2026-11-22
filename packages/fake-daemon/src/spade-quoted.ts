import { spadeChatSegments } from "@ace/ui-core/spade-chat";

type Json = Record<string, unknown>;

/*
 * What a person's reply quoted, as Spade stores it with their message (ADR 0212 §4;
 * `spade_core::chat_markup::quoted`): `m<seq>` is the event with that seq, `m<seq>.<n>` its n-th
 * message. An id Spade can't find quotes nothing.
 */

const mostQuote = 280;

export function fakeSpadeQuoted(
  events: readonly { seq: number; event: Json }[],
  id: unknown,
): Json | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^m(\d+)(?:\.(\d+))?$/.exec(id);
  if (!match) return undefined;
  const seq = Number(match[1]);
  const index = match[2] === undefined ? 0 : Number(match[2]) - 1;
  if (index < 0 || (match[2] !== undefined && index === 0)) return undefined;
  const event = events.find((stored) => stored.seq === seq)?.event;
  if (!event) return undefined;
  const text = typeof event.text === "string" ? event.text : "";
  const nth = (words: string) => {
    const segment = spadeChatSegments(words)[index];
    return segment && (segment.title ?? segment.text);
  };
  switch (event.type) {
    case "user_message": {
      if (index > 0 || event.from_agent || event.from_routine || event.from_group) return undefined;
      return { id, text: cut(text), mine: true };
    }
    case "step_finished":
    case "reply_stopped":
    case "reply_failed":
    case "reply_interrupted": {
      const words = nth(text);
      return words === undefined ? undefined : { id, text: cut(words), mine: false };
    }
    case "group_message": {
      const from = event.from as Json | null | undefined;
      if (!from) return index > 0 ? undefined : { id, text: cut(text), mine: true };
      const words = nth(text);
      return words === undefined
        ? undefined
        : { id, text: cut(words), mine: false, name: String(from.name ?? "") };
    }
    default:
      return undefined;
  }
}

function cut(text: string): string {
  const chars = [...text.trim()];
  return chars.length > mostQuote ? `${chars.slice(0, mostQuote - 1).join("")}…` : chars.join("");
}
