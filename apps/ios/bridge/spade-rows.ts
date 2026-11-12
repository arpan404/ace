import {
  spadeApprovalDetails,
  spadeCallLine,
  spadeCallShown,
  spadeCompactedLine,
  spadeJobEndLine,
  spadeReplyEndLine,
  spadeRowLabel,
  spadeUntitled,
  type SpadeConversationRow,
  type SpadeEntry,
  type SpadeView,
} from "@ace/ui-core/spade-chat";

/*
 * Spade's conversation and list as the iPhone draws them, from the shared fold and words
 * (`@ace/ui-core/spade-chat`). Pure: no I/O. Swift lays these rows out and decides nothing.
 */

/** One entry of a conversation, in the order the transcript shows it. */
type ReplyPart = { key: string; kind: "text" | "line"; text: string; failed: boolean };

export type SpadeRow =
  | { kind: "user"; text: string; images: string | null; pending: boolean }
  | {
      kind: "reply";
      /** Spade's words (markdown) and the quiet line of each call that has an outcome. */
      parts: ReplyPart[];
      /** The open step's words so far. */
      live: string;
      end: { text: string; alert: boolean } | null;
    }
  | { kind: "note"; text: string; centred: boolean };

const imagesLine = (count: number) =>
  count === 0 ? null : count === 1 ? "1 image" : `${count} images`;

export function spadeRow(entry: SpadeEntry): SpadeRow {
  switch (entry.kind) {
    case "user":
      return {
        kind: "user",
        text: entry.text,
        images: imagesLine(entry.images.length),
        pending: entry.pending === true,
      };
    case "reply":
      return {
        kind: "reply",
        parts: entry.parts.flatMap((part): ReplyPart[] =>
          part.kind === "text"
            ? [{ key: part.key, kind: "text", text: part.text, failed: false }]
            : spadeCallShown(part.state)
              ? [
                  {
                    key: part.key,
                    kind: "line",
                    text: spadeCallLine(part.name, part.state),
                    failed: part.state === "failed",
                  },
                ]
              : [],
        ),
        live: entry.live,
        end: spadeReplyEndLine(entry.end) ?? null,
      };
    case "compacted":
      return { kind: "note", text: spadeCompactedLine, centred: true };
    case "job":
      return { kind: "note", text: spadeJobEndLine(entry.name, entry.outcome), centred: false };
  }
}

/** The conversation around its entries: its name, its Working line and its oldest approval. */
export function spadeConversationPatch(id: string, view: SpadeView, problem: string | undefined) {
  const approval = view.approvals[0];
  return {
    type: "spade.conversation",
    id,
    title: view.title || spadeUntitled,
    loaded: view.loaded,
    problem: problem ?? null,
    busy: view.busy,
    answering: view.answering,
    working: view.working
      ? {
          label: view.working.label,
          since: view.working.since ?? null,
          moving: view.working.moving,
        }
      : null,
    approval: approval
      ? {
          callId: approval.callId,
          sentence: approval.sentence,
          more: view.approvals.length - 1,
          details: spadeApprovalDetails(approval.arguments) ?? null,
        }
      : null,
  };
}

/** One list row: its name, and Approve, Working or its age. */
export function spadeListRow(row: SpadeConversationRow, now: number) {
  const label = spadeRowLabel(row, now);
  return { id: row.id, title: row.title || spadeUntitled, tone: label.tone, label: label.label };
}
