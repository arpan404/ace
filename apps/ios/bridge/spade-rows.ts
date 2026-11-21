import {
  spadeBotRow,
  spadeGroupRow,
  spadeBubbles,
  spadeByState,
  spadeFailureSentence,
  spadeForLaterWords,
  spadeQuietLine,
  spadeRequestCard,
  spadeStateLine,
  type SpadeAgent,
  type SpadeBubble,
  type SpadeGroup,
  type SpadeRequestDetail,
  type SpadeRowState,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import type { SpadeStatus } from "@ace/protocol";
import { botFace, groupFaces, initialOf, type SpadeFaceRow } from "./spade-group-rows.ts";
import { spadeQuestionCardRow, type SpadeQuestionCardRow } from "./spade-question-rows.ts";

/*
 * Spade's list and one conversation as the iPhone draws them, from the rules every client shares
 * (`@ace/ui-core/spade-chat`). Pure: no I/O. Swift lays these rows out and decides nothing.
 */

/** One bot or group in the list: its face, its name, and its state and line as web's list says them. */
export interface SpadeListRow {
  id: string;
  conversation: string;
  name: string;
  /** Spade itself, the main bot: its face is the Spade mark. */
  main: boolean;
  /** A character face's initial, for a bot whose face the phone doesn't draw yet. */
  initial: string;
  /** A group's id (ADR 0132); null for a bot. */
  group: string | null;
  /** The faces the row shows: the bot's own, or a group's first three members'. */
  faces: SpadeFaceRow[];
  state: SpadeRowState;
  line: string;
  pinned: boolean;
}

/**
 * The connected machine's bots and groups in the list's order: Spade first, then the rest by
 * state, newest first within one, as web's list mixes them. While its Spade doesn't answer
 * (`answering` false) each row says so and nothing it was doing shows as still going, as web's
 * roster lists an unavailable machine.
 */
export function spadeListRows(
  agents: readonly SpadeAgent[],
  groups: readonly SpadeGroup[],
  machine: string,
  answering: boolean,
  hostId?: string,
): SpadeListRow[] {
  const place = {
    machine: { primary: false, name: machine },
    away: false,
    unavailable: !answering,
  };
  const still = { state: "idle" as const, status: undefined };
  const bots = agents.map((agent) => {
    const shown = answering ? agent : { ...agent, ...still };
    const row = spadeBotRow({ ...shown, ...place });
    const listed: SpadeListRow = {
      id: agent.id,
      conversation: agent.conversation,
      name: agent.name || "Untitled bot",
      main: agent.kind === "main",
      initial: initialOf(agent.name),
      group: null,
      faces: [botFace(agent)],
      state: row.state,
      line: row.line,
      pinned: agent.pinnedAt !== undefined,
    };
    return { listed, at: agent.lastActivity };
  });
  const clubs = groups.map((group) => {
    const shown = answering ? group : { ...group, ...still };
    const row = spadeGroupRow({ ...shown, ...place });
    const listed: SpadeListRow = {
      id: `group:${group.id}`,
      conversation: group.conversation,
      name: group.name,
      main: false,
      initial: initialOf(group.name),
      group: group.id,
      faces: groupFaces(group, agents, hostId),
      state: row.state,
      line: row.line,
      pinned: group.pinnedAt !== undefined,
    };
    return { listed, at: group.lastActivity };
  });
  const main = bots.filter(({ listed }) => listed.main);
  const rest = spadeByState(
    [...bots.filter(({ listed }) => !listed.main), ...clubs],
    ({ listed }) => listed.state,
    ({ at }) => at,
  );
  return [...main, ...rest].map(({ listed }) => listed);
}

/** What the Spade tab says about Spade itself while it isn't ready, and whether it offers Turn on. */
export function spadePlaceLine(status: SpadeStatus | undefined, enabled: boolean | undefined) {
  const line = spadeStateLine(status, enabled);
  return { sentence: line.sentence, ready: line.ready, canTurnOn: line.canTurnOn };
}

/** One bubble of a conversation, as the phone draws it. */
export type SpadeBubbleRow =
  | { kind: "person"; text: string; sending: boolean; attached: string | null }
  | {
      kind: "bot";
      /** Its words, markdown. */
      text: string;
      /** Still being written. */
      live: boolean;
      /** How it ended when it didn't finish on its own; `alert` when it failed. */
      end: { text: string; alert: boolean } | null;
    }
  /** An approval waiting on the person: Allow and Deny, and Always allow when it holds. */
  | {
      kind: "ask";
      callId: string;
      sentence: string;
      detail: string | null;
      reason: string | null;
      always: boolean;
    }
  /** A card of questions the bot asks (ADR 0154). */
  | SpadeQuestionCardRow
  /** Anything that is nobody's words: one quiet line between bubbles. */
  | { kind: "note"; text: string };

const attachedLine = (images: number, documents: number, voice: boolean): string | null => {
  const parts = [
    images ? `${images} ${images === 1 ? "image" : "images"}` : "",
    documents ? `${documents} ${documents === 1 ? "file" : "files"}` : "",
    voice ? "Voice message" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
};

/** A request's detail in plain words: the command, the path, the note, the message. */
export function spadeDetailText(detail: SpadeRequestDetail | undefined): string | null {
  if (!detail) return null;
  switch (detail.kind) {
    case "command":
      return detail.command;
    case "file":
      return detail.path;
    case "note":
      return detail.text;
    case "email":
      return [detail.to && `To ${detail.to}`, detail.subject].filter(Boolean).join(" · ") || null;
    case "message":
      return `To ${detail.to}: ${detail.text}`;
    case "task":
      return detail.after;
    case "fields":
      return detail.fields.map((field) => `${field.label}: ${field.value}`).join("\n") || null;
  }
}

const endText = { stopped: "Stopped", failed: "Couldn't finish", interrupted: "Interrupted" };

/** A bubble as the phone draws it; `who` is the bot's name, for the approval's sentence. */
export function spadeBubbleRow(bubble: SpadeBubble, who: string): SpadeBubbleRow | undefined {
  switch (bubble.kind) {
    case "person":
      return {
        kind: "person",
        text: bubble.text,
        sending: bubble.sending,
        attached: attachedLine(
          bubble.images.length,
          bubble.documents.length,
          bubble.voice !== undefined,
        ),
      };
    case "bot": {
      const end = bubble.end
        ? {
            text: bubble.failure
              ? spadeFailureSentence(bubble.failure.kind, bubble.failure.endpoint)
              : endText[bubble.end],
            alert: bubble.end === "failed",
          }
        : null;
      const shared = attachedLine(bubble.images.length, bubble.documents.length, false);
      const text = [bubble.text, shared && `_${shared}_`].filter(Boolean).join("\n\n");
      if (!text && !end) return undefined;
      return { kind: "bot", text, live: bubble.live, end };
    }
    case "ask": {
      const card = spadeRequestCard(bubble.name, bubble.arguments, who);
      return {
        kind: "ask",
        callId: bubble.callId,
        sentence: card.sentence,
        detail: spadeDetailText(card.detail),
        reason: bubble.reason ?? null,
        always: card.always,
      };
    }
    case "other":
      return { kind: "note", text: `${bubble.agent.name}: ${bubble.text}` };
    case "routine":
      return { kind: "note", text: bubble.label || bubble.name };
    case "task-paused":
    case "handback":
    case "helper":
      return { kind: "note", text: bubble.text };
    case "quiet":
      return { kind: "note", text: spadeQuietLine(bubble.quiet).label };
    // The workers a call started, by name, until the iPhone draws their cards.
    case "workers":
      return {
        kind: "note",
        text: `Started ${bubble.workers.map((worker) => worker.name).join(", ")}`,
      };
    case "remembered":
      return { kind: "note", text: `Remembered: ${bubble.note.text}` };
    // The iPhone doesn't show which notes a reply had in mind yet.
    case "recalled":
      return undefined;
    case "files":
      return { kind: "note", text: bubble.paths.join(", ") };
    case "question":
      return spadeQuestionCardRow(bubble, who);
    case "search-setup":
      return { kind: "note", text: "Web search isn't set up yet." };
  }
}

/** A conversation's bubbles with their keys, in order. */
export function spadeConversationRows(
  view: SpadeView,
  who: string,
): { key: string; row: SpadeBubbleRow }[] {
  return spadeBubbles(view).flatMap((bubble) => {
    const row = spadeBubbleRow(bubble, who);
    return row ? [{ key: bubble.key, row }] : [];
  });
}

/** The conversation around its bubbles: whether it has loaded, works, and why it can't follow. */
export function spadeConversationHead(
  id: string,
  view: SpadeView,
  problem: string | undefined,
  face: SpadeFaceRow | null = null,
) {
  return {
    type: "spade.conversation",
    id,
    loaded: view.loaded,
    problem: problem ?? null,
    answering: view.answering,
    // "2 questions for later" in the top bar, which goes to the oldest such card.
    later:
      view.questionsForLater > 0 && view.forLater[0]
        ? { words: spadeForLaterWords(view.questionsForLater), callId: view.forLater[0] }
        : null,
    working: view.working
      ? { label: view.status ?? view.working.label, moving: view.working.moving, face }
      : null,
  };
}
