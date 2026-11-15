import type { Interaction, ServerMessage } from "@ace/protocol";
import { requestChars, summarizeInteraction } from "@ace/projection/interaction-summary";
import { sha256Hex } from "./sha256.ts";

/*
 * Requests too large to send with their thread, as the daemon sends them (ADR 0156): summarized
 * everywhere a client gets an interaction, read whole with `interaction.read` in 64 Ki pages.
 */

/** UTF-16 code units of a request's JSON in one `interaction.data` page. */
const pageChars = 64 * 1024;

/** `message` with every interaction it carries as clients get it. */
export function summarizedOutgoing(message: ServerMessage): ServerMessage {
  switch (message.type) {
    case "snapshot":
      return message.view.kind === "thread"
        ? {
            ...message,
            view: {
              ...message.view,
              interactions: Object.fromEntries(
                Object.entries(message.view.interactions).map(([id, interaction]) => [
                  id,
                  summarizeInteraction(interaction),
                ]),
              ),
            },
          }
        : message;
    case "events":
      return {
        ...message,
        events: message.events.map((event) =>
          event.payload.type === "interaction.opened"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  interaction: summarizeInteraction(event.payload.interaction),
                },
              }
            : event,
        ),
      };
    case "entities.page":
      return message.page.collection === "interactions"
        ? {
            ...message,
            page: { ...message.page, entries: message.page.entries.map(summarizeInteraction) },
          }
        : message;
    default:
      return message;
  }
}

/** The page of `interaction`'s request JSON from `offset`, as `interaction.data` carries it. */
export function requestPage(interaction: Interaction, offset: number) {
  const json = JSON.stringify(interaction.request);
  const start = Math.min(offset, json.length);
  let end = Math.min(json.length, start + pageChars);
  // A page never ends between the halves of a surrogate pair.
  const last = json.charCodeAt(end - 1);
  if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
  return {
    version: sha256Hex(new TextEncoder().encode(json)),
    offset: start,
    nextOffset: end,
    total: requestChars(interaction.request),
    text: json.slice(start, end),
    eof: end === json.length,
  };
}
