import {
  spadeBotRow,
  spadeBotFamilies,
  spadeExpandedBotRow,
  spadeGroupRow,
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
  /** When the person pinned it (ms), for the pin strip's order, oldest first; null when it isn't. */
  pinnedAt: number | null;
  /** "Shared in Acme Robotics" for a bot an organization shares (ADR 0206 §2.3); null otherwise. */
  shared: string | null;
  /** Its latest activity (ms): the merged list across machines orders by it within a rank. */
  at: number;
  /** When it was made (ms): before any host choice, the oldest main shows as Spade. */
  createdAt: number;
  /** Its state's place in the list (`spadeRowRank`), lowest first. */
  rank: number;
  depth: 0 | 1;
  parent: { id: string; name: string } | null;
  /** The top-level bot under which the whole family is displayed. */
  familyRoot: string | null;
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
  const listBot = (
    agent: SpadeAgent,
    familyRoot: string | null,
    expanded = false,
  ): SpadeListRow => {
    const shown = answering ? agent : { ...agent, ...still };
    const status = spadeBotRow({ ...shown, ...place });
    const row = expanded ? spadeExpandedBotRow(status) : status;
    return {
      id: agent.id,
      conversation: agent.conversation,
      name: agent.name || "Untitled bot",
      main: agent.kind === "main",
      initial: initialOf(agent.name),
      group: null,
      faces: [dim(botFace(agent))],
      state: row.state,
      line: unconfirmed ?? row.line,
      pinned: agent.pinnedAt !== undefined,
      pinnedAt: agent.pinnedAt ?? null,
      shared: agent.kind === "main" ? null : sharedIn(agent.id),
      at: agent.lastActivity,
      createdAt: agent.createdAt,
      rank: spadeRowRank[row.state],
      depth: familyRoot === null ? 0 : 1,
      parent: agent.parent ?? null,
      familyRoot,
    };
  };
  const families = spadeBotFamilies(agents, (_agent, id) => id);
  const workersOf = new Map(families.map(({ root, workers }) => [root.id, workers]));
  const bots = families.map(({ root, workers }) =>
    listBot(
      root,
      null,
      workers.some((worker) => worker.pinnedAt === undefined),
    ),
  );
  const clubs = groups.map((group) => {
    const club = placeOf(reach.groups, machine);
    const shown = club.answering ? group : { ...group, ...still };
    const row = spadeGroupRow({ ...shown, ...club.place });
    return {
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
      pinnedAt: group.pinnedAt ?? null,
      shared: null,
      at: group.lastActivity,
      createdAt: group.createdAt,
      rank: spadeRowRank[row.state],
      depth: 0,
      parent: null,
      familyRoot: null,
    } satisfies SpadeListRow;
  });
  const ordered = (rows: readonly SpadeListRow[]) =>
    spadeByState(
      rows,
      (row) => row.state,
      (row) => row.at,
    );
  const main = bots.filter((bot) => bot.main);
  const rest = ordered([...bots.filter((bot) => !bot.main), ...clubs]);
  const rows: SpadeListRow[] = [];
  for (const root of [...main, ...rest]) {
    rows.push(root);
    if (root.group !== null) continue;
    const workers = workersOf.get(root.id) ?? [];
    for (const worker of ordered(workers.map((bot) => listBot(bot, root.id)))) rows.push(worker);
  }
  return rows;
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
      /**
       * Finished and long enough that it may draw past twenty lines: the phone shows its first twenty
       * and Show more when it does (ADR 0212 amendment 2).
       */
      fold: boolean;
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
  /**
   * A reply that changed the bot's files (ADR 0167): its steps in one quiet line (`text`, which
   * an older phone shows as a note), undoing the whole reply from its first such step, or one
   * step that changed files.
   */
  | {
      kind: "changes";
      text: string;
      undo: { from: number; stays: string[] };
      steps: { from: number; line: string; detail: string | null }[];
    }
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
      return {
        kind: "bot",
        text: bubble.text,
        live: bubble.live,
        fold: Boolean(bubble.fold),
        end,
        images,
        files,
      };
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
    // Only a reply undo can reach shows its steps: the rest of the work isn't drawn here yet.
    case "steps":
      return bubble.undo
        ? {
            kind: "changes",
            text: bubble.summary,
            undo: { from: bubble.undo.from, stays: [...new Set(bubble.undo.stays)] },
            steps: bubble.steps.flatMap((step) =>
              step.undoFrom === undefined
                ? []
                : [{ from: step.undoFrom, line: step.line, detail: step.detail ?? null }],
            ),
          }
        : undefined;
    case "question":
      return spadeQuestionCardRow(bubble, who);
  }
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
