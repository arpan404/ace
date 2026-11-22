import {
  spadeBotRow,
  spadeGroupRow,
  spadeBubbles,
  spadeByState,
  spadeFailureSentence,
  spadeForLaterWords,
  spadeQuietLine,
  spadeRequestCard,
  spadeRowRank,
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
import {
  spadeDocumentLines,
  spadeImageLines,
  spadeVoiceLine,
  type SpadeVoiceLine,
} from "./spade-image.ts";
import type { AttachmentLine } from "./thread-rows.ts";
import {
  spadeWorkersRow,
  unknownWorkers,
  type SpadeWorkerFacts,
  type SpadeWorkersRow,
} from "./spade-worker-rows.ts";

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
  /** "Shared in Acme Robotics" for a bot an organization shares (ADR 0206 §2.3); null otherwise. */
  shared: string | null;
  /** Its latest activity (ms): the merged list across machines orders by it within a rank. */
  at: number;
  /** When it was made (ms): before any host choice, the oldest main shows as Spade. */
  createdAt: number;
  /** Its state's place in the list (`spadeRowRank`), lowest first. */
  rank: number;
}

/**
 * How the machine's Spade answers now: it does; its machine answers but Spade doesn't (stopped,
 * off, restarting); the machine is out of reach; or it is back but its bots haven't been read
 * on this connection yet, `unconfirmed` saying so in a line. All but the first list the bots
 * from their last answer, and nothing they were doing shows as still going or done.
 */
export type SpadeReach = "answering" | "unavailable" | "away" | { unconfirmed: string };

/** How the bots' and the groups' last lists stand: each is read, and confirmed, on its own. */
export interface SpadeListReach {
  bots: SpadeReach;
  groups: SpadeReach;
}

/** The facts a row's rules read for one reach, and the line an unconfirmed one shows instead. */
function placeOf(reach: SpadeReach, machine: string) {
  const unconfirmed = typeof reach === "object" ? reach.unconfirmed : undefined;
  return {
    answering: reach === "answering",
    unconfirmed,
    place: {
      machine: { primary: false, name: machine },
      away: reach === "away",
      unavailable: reach === "unavailable" || unconfirmed !== undefined,
    },
  };
}

/**
 * The machine's bots and groups in the list's order: Spade first, then the rest by state, newest
 * first within one, as web's list mixes them. While its Spade doesn't answer (`reach`) each row
 * says so and nothing it was doing shows as still going, as web's roster lists an unavailable or
 * away machine.
 */
export function spadeListRows(
  agents: readonly SpadeAgent[],
  groups: readonly SpadeGroup[],
  machine: string,
  reach: SpadeListReach,
  hostId?: string,
  sharedIn: (agent: string) => string | null = () => null,
): SpadeListRow[] {
  const dim = (face: SpadeFaceRow): SpadeFaceRow =>
    reach.bots === "away" ? { ...face, away: true } : face;
  const still = { state: "idle" as const, status: undefined };
  const { answering, unconfirmed, place } = placeOf(reach.bots, machine);
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
      faces: [dim(botFace(agent))],
      state: row.state,
      line: unconfirmed ?? workerWaitLine(shown, row.line),
      pinned: agent.pinnedAt !== undefined,
      shared: agent.kind === "main" ? null : sharedIn(agent.id),
      at: agent.lastActivity,
      createdAt: agent.createdAt,
      rank: spadeRowRank[row.state],
    };
    return { listed, at: agent.lastActivity };
  });
  const clubs = groups.map((group) => {
    const club = placeOf(reach.groups, machine);
    const shown = club.answering ? group : { ...group, ...still };
    const row = spadeGroupRow({ ...shown, ...club.place });
    const listed: SpadeListRow = {
      id: `group:${group.id}`,
      conversation: group.conversation,
      name: group.name,
      main: false,
      initial: initialOf(group.name),
      group: group.id,
      faces: groupFaces(group, agents, hostId).map(dim),
      state: row.state,
      line: club.unconfirmed ?? row.line,
      pinned: group.pinnedAt !== undefined,
      shared: null,
      at: group.lastActivity,
      createdAt: group.createdAt,
      rank: spadeRowRank[row.state],
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

/**
 * A bot waiting on a worker it started: the row names that, since the request is the worker's,
 * shown on the workers row in the bot's chat (`spade-worker-rows.ts`). Spade's own status for
 * such a wait is generic ("A worker is waiting for you"), so it is replaced too.
 */
function workerWaitLine(agent: SpadeAgent, line: string): string {
  return agent.state === "waiting" && agent.waitingFor === "worker"
    ? "An agent it started needs you"
    : line;
}

/** What the Spade tab says about Spade itself while it isn't ready, and whether it offers Turn on. */
export function spadePlaceLine(status: SpadeStatus | undefined, enabled: boolean | undefined) {
  const line = spadeStateLine(status, enabled);
  return { sentence: line.sentence, ready: line.ready, canTurnOn: line.canTurnOn };
}

/** One bubble of a conversation, as the phone draws it. */
export type SpadeBubbleRow =
  | {
      kind: "person";
      text: string;
      sending: boolean;
      /** What it carries that isn't drawn; null now that every kind is (kept for older Swift). */
      attached: string | null;
      /** Its pictures, as a thread's message carries them, read by hash (`spade.image`). */
      images: AttachmentLine[];
      /** Its documents, file lines that open (`spade.document`). */
      files: AttachmentLine[];
      /** A voice message's recording, to play (`spade.audio`); its words are `text`. */
      voice: SpadeVoiceLine | null;
    }
  | {
      kind: "bot";
      /** Its words, markdown. */
      text: string;
      /** Still being written. */
      live: boolean;
      /** How it ended when it didn't finish on its own; `alert` when it failed. */
      end: { text: string; alert: boolean } | null;
      /** What its tools showed the person, after its words: pictures, and documents that open. */
      images: AttachmentLine[];
      files: AttachmentLine[];
    }
  /** An approval waiting on the person: Allow and Deny, and Always allow when it holds. */
  | {
      kind: "ask";
      callId: string;
      sentence: string;
      detail: string | null;
      reason: string | null;
      always: boolean;
      /** A shared bot's request: who may answer it (ADR 0206 §2.3); null for one's own bot. */
      approvers: string | null;
    }
  /** A card of questions the bot asks (ADR 0154). */
  | SpadeQuestionCardRow
  /** The workers one call started, each as it stands now (ADR 0161). */
  | SpadeWorkersRow
  /** Anything that is nobody's words: one quiet line between bubbles. */
  | { kind: "note"; text: string };

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

/**
 * A bubble as the phone draws it; `who` is the bot's name, for the approval's sentence, and
 * `workers` what is known of the workers it started.
 */
export function spadeBubbleRow(
  bubble: SpadeBubble,
  who: string,
  workers: SpadeWorkerFacts = unknownWorkers,
): SpadeBubbleRow | undefined {
  switch (bubble.kind) {
    case "person":
      return {
        kind: "person",
        text: bubble.text,
        sending: bubble.sending,
        attached: null,
        images: spadeImageLines(bubble.images),
        files: spadeDocumentLines(bubble.documents),
        voice: spadeVoiceLine(bubble.voice),
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
      const images = spadeImageLines(bubble.images);
      const files = spadeDocumentLines(bubble.documents);
      if (!bubble.text && !end && !images.length && !files.length) return undefined;
      return { kind: "bot", text: bubble.text, live: bubble.live, end, images, files };
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
        approvers: null,
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
    case "workers":
      return spadeWorkersRow(bubble.workers, workers);
    case "remembered":
      return { kind: "note", text: `Remembered: ${bubble.note.text}` };
    // The iPhone doesn't show which notes a reply had in mind yet.
    case "recalled":
      return undefined;
    case "files":
      return { kind: "note", text: bubble.paths.join(", ") };
    case "question":
      return spadeQuestionCardRow(bubble, who);
  }
}

/** A conversation's bubbles with their keys, in order. */
export function spadeConversationRows(
  view: SpadeView,
  who: string,
  workers: SpadeWorkerFacts = unknownWorkers,
  approvers: string | null = null,
): { key: string; row: SpadeBubbleRow }[] {
  return spadeBubbles(view).flatMap((bubble): { key: string; row: SpadeBubbleRow }[] => {
    const row = spadeBubbleRow(bubble, who, workers);
    if (row?.kind === "ask") return [{ key: bubble.key, row: { ...row, approvers } }];
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
