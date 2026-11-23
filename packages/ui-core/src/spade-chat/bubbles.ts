import type { SubagentState } from "../subagents.ts";
import type {
  SpadeApproval,
  SpadeEntry,
  SpadeQuestionCard,
  SpadeReplyEntry,
  SpadeAskKind,
  SpadeOutsideAsk,
  SpadeRequest,
} from "./fold.ts";
import type { SpadeRememberedNote } from "./notes.ts";
import type { SpadeDocumentRef, SpadeImageRef, SpadeVoiceRef } from "./media.ts";
import type { SpadeView } from "./view.ts";
import type { SpadeFailureKind, SpadeStoppedKind } from "./wire.ts";
import { spadeHelperLine } from "./helper-words.ts";
import type { SpadeContractAsked, SpadeContractEntry, SpadeTalkEntry } from "./bot-talk.ts";
import type { SpadeTogetherBubble } from "./together.ts";
import type { SpadeQuiet } from "./quiet.ts";
import { spadeReplySteps, type SpadeStep } from "./steps.ts";
import type { SpadeTurnUndo } from "./undo.ts";
import type { SpadeNoticeRow } from "./notices.ts";
import type { SpadeCardRow } from "./cards.ts";
import type { SpadeWorkersEntry } from "./delegations.ts";
import {
  spadeChatSegments,
  spadeLiveChatSegments,
  spadeMessageId,
  spadePlainChat,
} from "./chat-markup.ts";
import { spadeDocCard, type SpadeDocCard } from "./documents-in-chat.ts";
import { spadeMayFold } from "./long-messages.ts";
import { spadeQuoteOf, spadeSaid, type SpadeQuote, type SpadeSaid } from "./replies.ts";

/*
 * A conversation as a chat (ADR 0127): the person's messages and the bot's, and under each reply
 * its steps folded into one quiet line. Background jobs and compaction stay with the bot; an approval arrives
 * as a bubble of the bot's that the person answers, in place after the step that asked, and
 * stays once answered; a question as the bot's bubble (ADR 0128), and a note the bot saved as
 * one quiet line between its bubbles. Each carries when it was said, where that is known: a
 * message when Spade stored it, the bot's words when their reply began (`spadeChatRows` lays the
 * chat out by them).
 */
export type SpadeBubble = SpadeBubbleOf & { at?: number };

type SpadeBubbleOf =
  | { kind: "task-paused"; key: string; text: string }
  | {
      kind: "person";
      key: string;
      text: string;
      images: readonly SpadeImageRef[];
      documents: readonly SpadeDocumentRef[];
      /** A voice message: `text` is its transcript, and this its recording. */
      voice: SpadeVoiceRef | undefined;
      /** Not stored by Spade yet. */
      sending: boolean;
      /** Written in an ace thread (ADR 0198): the line above links back to it. */
      fromThread?: { id: string; title: string; machine?: string | undefined } | undefined;
      /** Its message id, once stored: what Reply quotes (ADR 0212 §3). */
      id?: string;
      /** The message it replies to: a small quoted line above it. */
      quote?: SpadeQuote;
    }
  /** One of the bot's routines fired: a small label, `Daily briefing · 9:00`. */
  | { kind: "routine"; key: string; name: string; label: string }
  /**
   * A message another bot sent into this conversation, labelled "From" it with the name it had;
   * a contract call it made reads as its card, with what this bot returned.
   */
  | {
      kind: "other";
      key: string;
      agent: { id: string; name: string };
      text: string;
      contract?: SpadeContractAsked;
      /** Its message id, which the person's Reply quotes (ADR 0212 §3). */
      id?: string;
      /** A `<doc>` it wrote, as a document card (ADR 0212 §5). */
      doc?: SpadeDocCard;
      /** Long enough to fold past twenty lines (ADR 0212 amendment 2, `spadeMayFold`). */
      fold?: true;
    }
  | {
      kind: "bot";
      key: string;
      text: string;
      /** Still being written. */
      live: boolean;
      /** How the reply ended when it didn't finish on its own. */
      end: "stopped" | "failed" | "interrupted" | undefined;
      /** Why it failed, when it did. */
      failure: SpadeBubbleFailure | undefined;
      /** Workspace files a tool kept since the bot's last bubble: chips that open each. */
      files?: readonly string[];
      /** What the reply's tools showed the person, after its words (ADR 0134). */
      images: readonly SpadeImageRef[];
      documents: readonly SpadeDocumentRef[];
      /**
       * The reply this is the last bubble of, when that reply finished: the bubble's More menu
       * offers Keep as a test (ADR 0204).
       */
      keep?: string;
      /** The turn it is part of, whose work lines Show work brings back (`spadeWorkTurn`). */
      turn?: string;
      /** Its message id, once its words are stored: what Reply quotes (ADR 0212 §3). */
      id?: string;
      /** The earlier message it replies to: a small quoted line above it. */
      quote?: SpadeQuote;
      /**
       * A `<doc>` the bot wrote, as a document card (ADR 0212 §5); its bubble then has no words.
       * A message, however long, is never one.
       */
      doc?: SpadeDocCard;
      /**
       * Finished and long enough that it may draw past twenty lines: the client shows its first twenty
       * and Show more when it does (ADR 0212 amendment 2). Never while it streams.
       */
      fold?: true;
      /**
       * The last words of a finished reply to a message another bot sent, which went back to
       * that bot: one quiet line under it says "Replied to Quill".
       */
      repliedTo?: { id: string; name: string };
    }
  /**
   * The notes Spade recalled for the message a finished reply answered (ADR 0128), by id: one
   * quiet line under the reply that opens to them and where each came from.
   */
  | { kind: "recalled"; key: string; notes: readonly string[]; turn?: string }
  /**
   * The steps a reply took, as one quiet line under it that opens to each (`spadeReplySteps`);
   * the ones the person must see stand under it unopened.
   */
  | {
      kind: "steps";
      key: string;
      summary: string;
      steps: readonly SpadeStep[];
      /** Undoing the whole turn's file changes, when any step can be undone (ADR 0167). */
      undo: SpadeTurnUndo | undefined;
      turn?: string;
    }
  /** Files a tool kept with no reply after them yet: chips on the bot's side. */
  | { kind: "files"; key: string; paths: readonly string[] }
  /** "Remembered: …": a note the bot saved or rewrote, which the person may open to edit. */
  | { kind: "remembered"; key: string; note: SpadeRememberedNote; turn?: string }
  /** An event that is nobody's words: one quiet line (`spadeQuietLine`), never a bubble. */
  | { kind: "quiet"; key: string; quiet: SpadeQuiet; turn?: string }
  /** "Updated its task: …", with the change behind See change and Undo. */
  | { kind: "task-changed"; key: string; task: string; previous: string; why: string }
  /** "Made a new bot: Research · …", with Open and Undo. */
  | { kind: "made"; key: string; bot: string; name: string; task: string }
  /** "Added Writer to Ops". */
  | {
      kind: "club-added";
      key: string;
      club: string;
      clubName: string;
      bot: string;
      botName: string;
    }
  /** A card the bot showed (ADR 0200 §5.1): its own row, drawn from its data by ace's parts. */
  | ({ kind: "card"; key: string } & SpadeCardRow)
  /** The bots and ace agents one call started, one row each, where the first started. */
  | Omit<SpadeWorkersEntry, "at">
  /** A bot's own notice (`notify`): its words and where it went. */
  | ({ kind: "notice"; key: string } & SpadeNoticeRow)
  /** "Named itself Ivy", the name and face changed in place from the line. */
  | { kind: "named"; key: string; name: string; face: boolean; first: boolean }
  /** The person handed the computer back: one quiet line, its names behind a disclosure. */
  | { kind: "handback"; key: string; text: string; data: readonly string[] }
  /**
   * A call the bot made to another bot's contract (ADR 0200 §7), as its card
   * (`spadeContractCard`): never hidden with the work, as it is whom the bot asked.
   */
  | {
      kind: "contract";
      key: string;
      call: Omit<SpadeContractEntry, "kind" | "key">;
      /** How it stands, in ace's words for a child (`spadeChildState`). */
      state: SubagentState;
      at?: number;
    }
  /**
   * The messages one turn sent another bot, with their replies, as one card (`spadeTalkCard`):
   * never hidden with the work.
   */
  | ({ kind: "talk" } & Omit<SpadeTalkEntry, "kind" | "at"> & { at?: number })
  /** A turn's talk, contract calls and started workers as one card (`spadeTogether`). */
  | Omit<SpadeTogetherBubble, "at">
  /**
   * A helper the bot started (ADR 0152): one quiet line in Spade's words that expands to the
   * helper's own steps, read from its job's hidden conversation.
   */
  | {
      kind: "helper";
      key: string;
      job: string;
      text: string;
      /** Still working (or waiting on the person). */
      open: boolean;
      /** How it stands, in ace's words for a child (`spadeChildState`). */
      state: SubagentState;
    }
  /**
   * A card of questions (ADR 0154), as the bot's bubble where it asked, with how it stands:
   * waiting or for later (its inputs), answered, dismissed, or closed.
   */
  | ({ kind: "question"; key: string } & SpadeQuestionCard)
  /**
   * A call that asks the person, as the bot's bubble where it asked: open while it waits on
   * them, then how they answered, or `closed` when its reply ended first. `name`: the tool, for
   * the request's words (`spadeRequestCard`).
   */
  | {
      kind: "ask";
      key: string;
      callId: string;
      name: string;
      /** What the call would do, as the bot sent it. */
      arguments: unknown;
      /** Why the model review asked the person: "It could spend money, so you decide." */
      reason: string | undefined;
      /** Why Spade asked (ADR 0171); the choices on the card follow it. */
      ask?: SpadeAskKind;
      /** Which of Spade's judges stopped it and put it to the person (ADR 0163, amendment 3). */
      stopped?: SpadeStoppedKind;
      /**
       * For a driving step, the app or site the card offers to allow for the bot; for a connected
       * app's write (`ask: "app"`), the connection whose writes it offers to allow always.
       */
      app?: string;
      /** What the gate read the call as doing; absent: undeclared (ADR 0202, amendment 5). */
      effect?: string;
      /** For a connected app's tool, the definition the person is shown. */
      definition?: string;
      /** A helper's call (ADR 0152): its task. */
      helper: { job: string; task: string } | undefined;
      state: "open";
    }
  /**
   * A plugin's server or hook asking to run outside the sandbox (ADR 0167), open until the
   * person answers: Allow (once), Always for this plugin version, or Deny.
   */
  | ({ kind: "plugin-outside"; key: string } & SpadeOutsideAsk);

/** Why a reply failed, as its bubble says it. */
export interface SpadeBubbleFailure {
  kind: SpadeFailureKind;
  /** The endpoint's id, when the endpoint was to blame. */
  endpoint: string | undefined;
  /** The endpoint's or Spade's own words, for Details and the activity log. */
  error: string;
  /**
   * The failed reply's id, for Try again (`POST …/retry`), which answers the same turn again in
   * its place: only on the conversation's last reply.
   */
  retry: string | undefined;
}

/** What a bot answers a heartbeat when nothing needs the person (`spade_core::routine::QUIET`). */
export const spadeQuiet = "[quiet]";

/** Whether a reply's text is the quiet answer (case and a trailing full stop ignored). */
export function isSpadeQuiet(text: string): boolean {
  return text.trim().replace(/\.+$/, "").trim().toLowerCase() === spadeQuiet;
}

/**
 * Where the pass over a conversation's entries stands after some of them: what each next entry's
 * bubbles depend on. Every entry's bubbles depend only on the entries before it and the open
 * approvals, so a pass can stop after any entry and go on later (`SpadeBubbleCache`).
 */
export interface SpadeBubblePass {
  readonly view: Pick<SpadeView, "approvals">;
  /** The approvals waiting on the person, by call id. */
  readonly open: ReadonlyMap<string, SpadeView["approvals"][number]>;
  /** Files kept since the bot's last bubble, for its next one. */
  held: Held;
  /** The notes recalled for the latest message, until the reply to it finishes. */
  recalled: readonly string[];
  /**
   * Another bot's plain message the next finished reply answers back to, and where its bubbles
   * began.
   */
  answering: SpadeAnswering | undefined;
  /**
   * Since the last reply ended: whether anything arrived, and whether all of it was a heartbeat.
   * A quiet answer only to heartbeats shows as nothing, like the heartbeats themselves (ADR 0129;
   * `silent_replies` in spade-core); one that also answers anything else always shows.
   */
  inputs: boolean;
  onlyBeats: boolean;
  /**
   * And whether all of it came from a group the bot is in: a group's message and the reply to it
   * live in the group (ADR 0132; `answering_replies` in spade-core), so the bot's own chat shows
   * only the cards of such a reply still waiting on the person here.
   */
  onlyGroups: boolean;
  /** The requests placed so far, by call id, in order. */
  shown: string[];
  /** What later replies may quote, as the chat reaches it (ADR 0212 §4). */
  readonly said: SpadeSaid;
}

export interface SpadeAnswering {
  readonly id: string;
  readonly name: string;
  readonly from: number;
}

/** A pass before any entry; `said` is where it keeps what it shows, fresh by default. */
export function spadeBubblePass(
  view: Pick<SpadeView, "approvals">,
  said: SpadeSaid = spadeSaid(),
): SpadeBubblePass {
  return {
    view,
    open: new Map(view.approvals.map((approval) => [approval.callId, approval])),
    held: { paths: [], key: undefined },
    recalled: [],
    answering: undefined,
    inputs: false,
    onlyBeats: true,
    onlyGroups: true,
    shown: [],
    said,
  };
}

export function spadeBubbles(view: SpadeView): SpadeBubble[] {
  const bubbles: SpadeBubble[] = [];
  const pass = spadeBubblePass(view);
  for (const entry of view.entries) spadeBubbleStep(pass, bubbles, entry);
  return spadeBubblesFinish(pass, bubbles, view);
}

/** A request where it was asked: shown only while it still waits on the person. */
function askAt(
  pass: SpadeBubblePass,
  bubbles: SpadeBubble[],
  request: SpadeRequest,
  key: string,
  at: number | undefined,
) {
  pass.shown.push(request.callId);
  // Only a request still waiting on the person shows; once answered or closed it is finished.
  const waiting = pass.open.get(request.callId);
  if (waiting) bubbles.push({ ...askBubble(request, key, waiting), ...stamp(at) });
}

/** Something reached the bot as a message would: a reply to it shows. */
function arrived(pass: SpadeBubblePass) {
  pass.inputs = true;
  pass.onlyBeats = false;
  pass.onlyGroups = false;
}

/** One entry's bubbles, added to `bubbles`, the pass moved past it. */
export function spadeBubbleStep(
  pass: SpadeBubblePass,
  bubbles: SpadeBubble[],
  entry: SpadeView["entries"][number],
): void {
  if (entry.kind === "request") {
    askAt(pass, bubbles, entry, entry.key, entry.at);
    return;
  }
  if (entry.kind === "question") {
    bubbles.push(entry);
    return;
  }
  if (entry.kind === "job") {
    arrived(pass);
    hold(pass.held, entry.key, entry.files);
  }
  if (entry.kind === "task-paused") {
    bubbles.push({
      kind: "task-paused",
      key: entry.key,
      text:
        entry.reason === "budget"
          ? `Paused after ${entry.steps} steps on its own. Send a message to let it carry on.`
          : `Paused: its last ${entry.steps} steps changed nothing. Send a message to let it carry on.`,
    });
    return;
  }
  if (
    entry.kind === "task-changed" ||
    entry.kind === "named" ||
    entry.kind === "made" ||
    entry.kind === "club-added"
  ) {
    pass.onlyGroups = false;
    bubbles.push(entry);
    return;
  }
  if (entry.kind === "card" || entry.kind === "notice" || entry.kind === "workers") {
    pass.onlyGroups = false;
    const { at, ...row } = entry;
    bubbles.push({ ...row, ...stamp(at) });
    return;
  }
  if (entry.kind === "quiet") {
    pass.onlyGroups = false;
    bubbles.push({ kind: "quiet", key: entry.key, quiet: entry.quiet, ...stamp(entry.at) });
    return;
  }
  if (entry.kind === "handback") {
    bubbles.push({ kind: "handback", key: entry.key, text: entry.text, data: entry.data });
    return;
  }
  if (entry.kind === "contract") {
    // Its result reaches the bot like a message.
    if (entry.outcome) arrived(pass);
    const { kind: _kind, key, at, ...call } = entry;
    bubbles.push({
      kind: "contract",
      key,
      call,
      state: spadeChildState(entry.outcome, false),
      ...stamp(at),
    });
    return;
  }
  if (entry.kind === "talk") {
    // Each reply reaches the bot like a message.
    if (entry.exchanges.some((exchange) => exchange.outcome !== undefined)) arrived(pass);
    bubbles.push(entry);
    return;
  }
  if (entry.kind === "helper") {
    // Its result reaches the bot like a message.
    if (entry.outcome) arrived(pass);
    const waiting = pass.view.approvals.some((approval) => approval.helper?.job === entry.job);
    bubbles.push({
      kind: "helper",
      key: entry.key,
      job: entry.job,
      text: spadeHelperLine(entry, waiting),
      open: entry.outcome === undefined,
      state: spadeChildState(entry.outcome, waiting),
      ...stamp(entry.at),
    });
    return;
  }
  if (entry.kind === "user") {
    userBubbles(pass, bubbles, entry);
    return;
  }
  if (entry.kind !== "reply") return;
  // The whole reply, every step's words: hidden only if all it said was [quiet], and it left
  // nothing else to show (a note it remembered, a question for the person).
  const whole = [
    ...entry.parts.flatMap((part) => (part.kind === "text" ? [spadePlainChat(part.text)] : [])),
    ...(entry.live
      ? [
          spadeLiveChatSegments(entry.live)
            .map((segment) => segment.text)
            .join("\n\n"),
        ]
      : []),
  ]
    .join("\n\n")
    .trim();
  const quiet =
    pass.inputs &&
    pass.onlyBeats &&
    entry.parts.every((part) => part.kind === "text" || part.kind === "call") &&
    (entry.end === undefined
      ? spadeQuiet.startsWith(whole.toLowerCase())
      : entry.end.kind === "finished" && isSpadeQuiet(whole));
  const grouped = pass.inputs && pass.onlyGroups;
  if (entry.end !== undefined) {
    pass.inputs = false;
    pass.onlyBeats = true;
    pass.onlyGroups = true;
  }
  const ask = (request: SpadeRequest, key: string, at: number | undefined) =>
    askAt(pass, bubbles, request, key, at);
  // Where this reply's bubbles begin: it marks only its own, so earlier entries' stay as made.
  const start = bubbles.length;
  if (grouped) cardBubbles(entry, bubbles, ask);
  else if (!quiet) replyBubbles(entry, bubbles, pass.held, ask, pass.said);
  // A finished reply's words went back to the bot that wrote: its last bubble says so.
  const answering = pass.answering;
  if (answering && entry.end?.kind === "finished")
    for (let at = bubbles.length - 1; at >= Math.max(answering.from, start); at--) {
      const bubble = bubbles[at];
      if (bubble?.kind !== "bot") continue;
      bubbles[at] = { ...bubble, repliedTo: { id: answering.id, name: answering.name } };
      break;
    }
  if (entry.end !== undefined) pass.answering = undefined;
  // What it had in mind, under the reply that answered the message, once it finished.
  if (!quiet && !grouped && entry.end && pass.recalled.length) {
    bubbles.push({
      kind: "recalled",
      key: `${entry.key}:recalled`,
      notes: pass.recalled,
      turn: entry.key,
    });
    pass.recalled = [];
  } else
    for (const part of entry.parts)
      if (part.kind === "files") hold(pass.held, part.key, part.paths);
}

/** A message into the conversation: the person's, another bot's, a routine's or a group's. */
function userBubbles(
  pass: SpadeBubblePass,
  bubbles: SpadeBubble[],
  entry: Extract<SpadeView["entries"][number], { kind: "user" }>,
) {
  pass.recalled = entry.recalled ?? [];
  // A plain message from another bot is answered back to it; a contract call by its return.
  pass.answering = undefined;
  pass.inputs = true;
  pass.onlyBeats &&= entry.fromRoutine?.heartbeat === true;
  pass.onlyGroups &&= entry.fromGroup !== undefined;
  if (entry.fromRoutine) {
    if (!entry.fromRoutine.heartbeat)
      bubbles.push({
        kind: "routine",
        key: entry.key,
        name: entry.fromRoutine.name,
        label: entry.fromRoutine.label,
        ...stamp(entry.at),
      });
    return;
  }
  if (entry.fromGroup) return;
  const from = entry.fromAgent;
  if (from && !from.contract) {
    // Another bot's words split into its messages as a reply's do (ADR 0212 §2). Their
    // quotes name its own conversation's messages, foreign here, so they drop (§4).
    otherBubbles(entry.key, entry.text, from, entry.id, entry.at, bubbles, pass.said);
    // A plain message from another bot is answered back to it.
    pass.answering = { id: from.id, name: from.name, from: bubbles.length };
    return;
  }
  if (entry.id && !from) pass.said.add(entry.id, entry.text, { kind: "person" });
  bubbles.push(
    from
      ? {
          kind: "other",
          key: entry.key,
          agent: { id: from.id, name: from.name },
          text: entry.text,
          ...(from.contract ? { contract: from.contract } : {}),
          ...stamp(entry.at),
        }
      : {
          kind: "person",
          key: entry.key,
          text: entry.text,
          images: entry.images,
          documents: entry.documents ?? [],
          voice: entry.voice,
          sending: entry.pending === true,
          ...(entry.fromThread ? { fromThread: entry.fromThread } : {}),
          ...(entry.id ? { id: entry.id } : {}),
          ...(entry.replyTo ? { quote: spadeQuoteOf(entry.replyTo) } : {}),
          ...stamp(entry.at),
        },
  );
}

/**
 * The bubbles that close a pass over every entry, added to `bubbles`: files still held, Try again
 * on a failed last reply, and anything waiting that no entry placed.
 */
export function spadeBubblesFinish(
  pass: SpadeBubblePass,
  bubbles: SpadeBubble[],
  view: Pick<SpadeView, "approvals" | "outsideAsks" | "entries">,
): SpadeBubble[] {
  const { held } = pass;
  const shown = new Set(pass.shown);
  if (held.key !== undefined && held.paths.length)
    bubbles.push({ kind: "files", key: `files:${held.key}`, paths: held.paths });
  offerRetry(bubbles, view.entries);
  // Anything still waiting that no stored step placed: at the end, where it is asked now.
  for (const approval of view.approvals)
    if (!shown.has(approval.callId))
      bubbles.push(askBubble({ ...approval, answer: undefined, always: false }, "", approval));
  // Plugins asking to run outside the sandbox: not any reply's, so at the end, while open.
  for (const outside of view.outsideAsks)
    bubbles.push({ kind: "plugin-outside", key: `outside:${outside.id}`, ...outside });
  return bubbles;
}

/**
 * A helper's or a contract call's state as ace says a child's: waiting on the person, at work,
 * done, failed or stopped. Never done while it hasn't ended (AGENTS.md priority 1).
 */
export function spadeChildState(
  outcome: "done" | "returned" | "failed" | "stopped" | undefined,
  waiting: boolean,
): SubagentState {
  if (outcome === undefined) return waiting ? "human" : "working";
  if (outcome === "failed") return "failed";
  if (outcome === "stopped") return "cancelled";
  return "done";
}

/** `at` as a bubble carries it: absent when unknown. */
const stamp = (at: number | undefined): { at?: number } => (at === undefined ? {} : { at });

/** A request's card: only one still waiting on the person shows, with the newest reason it has. */
function askBubble(
  request: SpadeRequest,
  key: string,
  waiting: SpadeApproval,
): Extract<SpadeBubble, { kind: "ask" }> {
  return {
    kind: "ask",
    key: key || `ask:${request.callId}`,
    callId: request.callId,
    name: request.name,
    arguments: request.arguments,
    reason: waiting.reason ?? request.reason,
    ...((waiting.ask ?? request.ask) ? { ask: waiting.ask ?? request.ask } : {}),
    ...((waiting.stopped ?? request.stopped)
      ? { stopped: waiting.stopped ?? request.stopped }
      : {}),
    ...((waiting.app ?? request.app) ? { app: waiting.app ?? request.app } : {}),
    ...((waiting.effect ?? request.effect) ? { effect: waiting.effect ?? request.effect } : {}),
    ...((waiting.definition ?? request.definition)
      ? { definition: waiting.definition ?? request.definition }
      : {}),
    helper: waiting.helper ?? request.helper,
    state: "open",
  };
}

/**
 * A reply's bubbles: each step's words is a bubble of its own, as a messenger shows several
 * messages in a row; a note it remembered or a question it asked splits the words too. The images
 * and documents its tools showed ride on the bubble before them (ADR 0134). The steps it took
 * fold into one line under its words (`spadeReplySteps`): a step still running is the working
 * line's, and a request the person answered is one of the steps. The first bubble keeps the
 * reply's key, so a bubble keeps its place as the reply grows.
 */
function replyBubbles(
  entry: SpadeReplyEntry,
  bubbles: SpadeBubble[],
  held: Held,
  ask: (request: SpadeRequest, key: string, at: number | undefined) => void,
  said: SpadeSaid,
) {
  const at = stamp(entry.startedAt);
  let images: SpadeImageRef[] = [];
  let documents: SpadeDocumentRef[] = [];
  let count = 0;
  // Where this reply's newest bot bubble sits, while nothing else has been added after it.
  let latest = -1;
  const take = () => {
    const media = { images, documents };
    images = [];
    documents = [];
    return media;
  };
  const push = (text: string, live: boolean, extra: BotExtra = {}) => {
    pushBot(bubbles, held, {
      key: count++ ? `${entry.key}:${count}` : entry.key,
      turn: entry.key,
      text,
      live,
      end: undefined,
      failure: undefined,
      ...take(),
      ...extra,
      ...at,
    });
    latest = bubbles.length - 1;
  };
  /**
   * One step's words as the messages they hold (ADR 0212 §2), each a bubble of its own; `seq`,
   * the stored event holding them, names each (§3). Live words have no ids yet.
   */
  const say = (text: string, live: boolean, seq: number | undefined) => {
    const segments = live ? spadeLiveChatSegments(text) : spadeChatSegments(text);
    segments.forEach((segment, index) => {
      const id = seq === undefined ? undefined : spadeMessageId(seq, index);
      const quote = segment.reply === undefined ? undefined : said.quote(segment.reply);
      const open = live && !!segment.open;
      const doc = segment.kind === "doc" ? spadeDocCard(segment.title, segment.text) : undefined;
      push(doc ? "" : segment.text, open, {
        ...(id ? { id } : {}),
        ...(quote ? { quote } : {}),
        ...(doc ? { doc } : {}),
        ...(!doc && !open && spadeMayFold(segment.text) ? { fold: true as const } : {}),
      });
      if (id) said.add(id, segment.title ?? segment.text, { kind: "bot" });
    });
  };
  /** The last bubble of the reply, when it is still the chat's last. */
  const tail = () => {
    const bubble = latest === bubbles.length - 1 ? bubbles[latest] : undefined;
    return bubble?.kind === "bot" ? bubble : undefined;
  };
  const attach = () => {
    const bubble = tail();
    if (!bubble || (!images.length && !documents.length)) return;
    bubbles[latest] = {
      ...bubble,
      images: [...bubble.images, ...images],
      documents: [...bubble.documents, ...documents],
    };
    images = [];
    documents = [];
  };
  for (const part of entry.parts) {
    if (part.kind === "text") {
      const text = part.text.trim();
      if (text) say(text, false, part.seq);
    } else if (part.kind === "shared") {
      images.push(...part.images);
      documents.push(...part.documents);
      attach();
    } else if (part.kind === "remembered") {
      bubbles.push({
        kind: "remembered",
        key: `${entry.key}:${part.key}`,
        note: part.note,
        turn: entry.key,
      });
    } else if (part.kind === "question") {
      bubbles.push({ ...part, key: `${entry.key}:${part.key}`, ...at });
    } else if (part.kind === "files") {
      hold(held, part.key, part.paths);
    } else if (part.kind === "request") {
      ask(part, `${entry.key}:${part.key}`, entry.startedAt);
    }
  }
  const live = entry.end === undefined ? entry.live.trim() : "";
  // The streaming words grow a bubble of their own.
  if (live) say(live, true, undefined);
  const end = entry.end && entry.end.kind !== "finished" ? entry.end.kind : undefined;
  const failure =
    entry.end?.kind === "failed"
      ? {
          kind: entry.end.failure,
          endpoint: entry.end.endpoint,
          error: entry.end.error,
          retry: undefined,
        }
      : undefined;
  if (end) {
    // How it ended sits on its last words, or stands alone when nothing was said after.
    const bubble = tail();
    if (bubble && !bubble.end) bubbles[latest] = { ...bubble, end, failure };
    else {
      push("", false);
      const added = bubbles[latest];
      if (added?.kind === "bot") bubbles[latest] = { ...added, end, failure };
    }
  }
  // Media with no words before it.
  if (images.length || documents.length) {
    if (tail()) attach();
    else push("", false);
  }
  // A finished reply can be kept as a test, from its last words.
  if (entry.end?.kind === "finished") {
    const bubble = bubbles[latest];
    if (bubble?.kind === "bot" && (bubble.text || bubble.doc))
      bubbles[latest] = { ...bubble, keep: entry.reply };
  }
  // Where it ran when its route moved it (ADR 0205 §2): once per line, the one that says why
  // before "like the step before".
  const served = [
    ...new Set(entry.parts.flatMap((part) => (part.kind === "served" ? [part.line] : []))),
  ];
  const why = served.filter((line) => line.includes(":"));
  for (const line of why.length ? why : served.slice(0, 1))
    bubbles.push({
      kind: "quiet",
      key: `${entry.key}:served:${line}`,
      quiet: { kind: "served", line },
      turn: entry.key,
    });
  // What it did, under what it said.
  const steps = spadeReplySteps(entry);
  if (steps) bubbles.push({ kind: "steps", key: `${entry.key}:steps`, ...steps, turn: entry.key });
}

/** A group's reply in the bot's own chat: only its cards, where the person answers them. */
function cardBubbles(
  entry: SpadeReplyEntry,
  bubbles: SpadeBubble[],
  ask: (request: SpadeRequest, key: string, at: number | undefined) => void,
) {
  for (const part of entry.parts)
    if (part.kind === "question")
      bubbles.push({ ...part, key: `${entry.key}:${part.key}`, ...stamp(entry.startedAt) });
    else if (part.kind === "request") ask(part, `${entry.key}:${part.key}`, entry.startedAt);
}

/** Another bot's message as the bubbles of its messages, each with its id and any card. */
function otherBubbles(
  key: string,
  text: string,
  agent: { id: string; name: string },
  seq: string | undefined,
  at: number | undefined,
  bubbles: SpadeBubble[],
  said: SpadeSaid,
) {
  const base = seq ? Number(seq.slice(1)) : undefined;
  spadeChatSegments(text).forEach((segment, index) => {
    const id = base === undefined ? undefined : spadeMessageId(base, index);
    const doc = segment.kind === "doc" ? spadeDocCard(segment.title, segment.text) : undefined;
    bubbles.push({
      kind: "other",
      key: index ? `${key}:${index + 1}` : key,
      agent: { id: agent.id, name: agent.name },
      text: doc ? "" : segment.text,
      ...(id ? { id } : {}),
      ...(doc ? { doc } : {}),
      ...(!doc && spadeMayFold(segment.text) ? { fold: true as const } : {}),
      ...stamp(at),
    });
    if (id) said.add(id, segment.title ?? segment.text, { kind: "member", name: agent.name });
  });
}

/** What a bot bubble may carry beyond its words: its id, quote, document card and fold. */
type BotExtra = { id?: string; quote?: SpadeQuote; doc?: SpadeDocCard; fold?: true };

interface Held {
  paths: string[];
  /** The first holder's key, which a standalone chip bubble takes. */
  key: string | undefined;
}

function hold(held: Held, key: string, paths: readonly string[]) {
  if (!paths.length) return;
  held.key ??= key;
  for (const path of paths) if (!held.paths.includes(path)) held.paths.push(path);
}

/** A bubble of the bot's, carrying the files kept since its last one. */
function pushBot(
  bubbles: SpadeBubble[],
  held: Held,
  bubble: Omit<Extract<SpadeBubble, { kind: "bot" }>, "kind" | "files" | "at"> & { at?: number },
) {
  const files = held.paths.length ? { files: held.paths.slice() } : {};
  held.paths.length = 0;
  held.key = undefined;
  bubbles.push({ kind: "bot", ...bubble, ...files });
}

/**
 * Try again on the last bubble when the conversation's last reply failed: Spade answers that turn
 * again in place, so nothing the person sent (words, pictures, files) is posted twice.
 */
function offerRetry(bubbles: SpadeBubble[], entries: readonly SpadeEntry[]) {
  const at = bubbles.length - 1;
  const last = bubbles[at];
  if (last?.kind !== "bot" || !last.failure) return;
  const reply = entries.at(-1);
  if (reply?.kind !== "reply" || reply.end?.kind !== "failed") return;
  bubbles[at] = { ...last, failure: { ...last.failure, retry: reply.reply } };
}
