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
import type { SpadeQuiet } from "./quiet.ts";
import { spadeReplySteps, type SpadeStep } from "./steps.ts";

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
    }
  /** One of the bot's routines fired: a small label, `Daily briefing · 9:00`. */
  | { kind: "routine"; key: string; name: string; label: string }
  /** A message another bot sent into this conversation, labelled with the name it had. */
  | { kind: "other"; key: string; agent: { id: string; name: string }; text: string }
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
    }
  /**
   * The steps a reply took, as one quiet line under it that opens to each (`spadeReplySteps`);
   * the ones the person must see stand under it unopened.
   */
  | { kind: "steps"; key: string; summary: string; steps: readonly SpadeStep[] }
  /** Files a tool kept with no reply after them yet: chips on the bot's side. */
  | { kind: "files"; key: string; paths: readonly string[] }
  /** "Remembered: …": a note the bot saved or rewrote, which the person may open to edit. */
  | { kind: "remembered"; key: string; note: SpadeRememberedNote }
  /** Web search had nothing set up: a quiet line that opens Settings › Spade › Web search. */
  | { kind: "search-setup"; key: string }
  /** An event that is nobody's words: one quiet line (`spadeQuietLine`), never a bubble. */
  | { kind: "quiet"; key: string; quiet: SpadeQuiet }
  /** The person handed the computer back: one quiet line, its names behind a disclosure. */
  | { kind: "handback"; key: string; text: string; data: readonly string[] }
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
      /** For a driving step, the app or site the card offers to allow for the bot. */
      app?: string;
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

export function spadeBubbles(view: SpadeView): SpadeBubble[] {
  const bubbles: SpadeBubble[] = [];
  // Files kept since the bot's last bubble, for its next one.
  const held: Held = { paths: [], key: undefined };
  // Since the last reply ended: whether anything arrived, and whether all of it was a heartbeat.
  // A quiet answer only to heartbeats shows as nothing, like the heartbeats themselves (ADR 0129;
  // `silent_replies` in spade-core); one that also answers anything else always shows.
  let inputs = false;
  let onlyBeats = true;
  // And whether all of it came from a group the bot is in: a group's message and the reply to it
  // live in the group (ADR 0132; `answering_replies` in spade-core), so the bot's own chat shows
  // only the cards of such a reply still waiting on the person here.
  let onlyGroups = true;
  const open = new Map(view.approvals.map((approval) => [approval.callId, approval]));
  const shown = new Set<string>();
  const ask = (request: SpadeRequest, key: string, at: number | undefined) => {
    shown.add(request.callId);
    // Only a request still waiting on the person shows; once answered or closed it is finished.
    const waiting = open.get(request.callId);
    if (waiting) bubbles.push({ ...askBubble(request, key, waiting), ...stamp(at) });
  };
  for (const entry of view.entries) {
    if (entry.kind === "request") {
      ask(entry, entry.key, entry.at);
      continue;
    }
    if (entry.kind === "question") {
      bubbles.push(entry);
      continue;
    }
    if (entry.kind === "job") {
      inputs = true;
      onlyBeats = false;
      onlyGroups = false;
      hold(held, entry.key, entry.files);
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
      continue;
    }
    if (entry.kind === "quiet") {
      onlyGroups = false;
      bubbles.push({ kind: "quiet", key: entry.key, quiet: entry.quiet, ...stamp(entry.at) });
      continue;
    }
    if (entry.kind === "handback") {
      bubbles.push({ kind: "handback", key: entry.key, text: entry.text, data: entry.data });
      continue;
    }
    if (entry.kind === "helper") {
      // Its result reaches the bot like a message.
      if (entry.outcome) {
        inputs = true;
        onlyBeats = false;
        onlyGroups = false;
      }
      const waiting = view.approvals.some((approval) => approval.helper?.job === entry.job);
      bubbles.push({
        kind: "helper",
        key: entry.key,
        job: entry.job,
        text: spadeHelperLine(entry, waiting),
        open: entry.outcome === undefined,
        ...stamp(entry.at),
      });
      continue;
    }
    if (entry.kind === "user") {
      inputs = true;
      onlyBeats &&= entry.fromRoutine?.heartbeat === true;
      onlyGroups &&= entry.fromGroup !== undefined;
      if (entry.fromRoutine) {
        if (!entry.fromRoutine.heartbeat)
          bubbles.push({
            kind: "routine",
            key: entry.key,
            name: entry.fromRoutine.name,
            label: entry.fromRoutine.label,
            ...stamp(entry.at),
          });
        continue;
      }
      if (entry.fromGroup) continue;
      bubbles.push(
        entry.fromAgent
          ? {
              kind: "other",
              key: entry.key,
              agent: entry.fromAgent,
              text: entry.text,
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
              ...stamp(entry.at),
            },
      );
      continue;
    }
    if (entry.kind !== "reply") continue;
    // The whole reply, every step's words: hidden only if all it said was [quiet], and it left
    // nothing else to show (a note it remembered, a question for the person).
    const whole = [
      ...entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
      ...(entry.live ? [entry.live] : []),
    ]
      .join("\n\n")
      .trim();
    const quiet =
      inputs &&
      onlyBeats &&
      entry.parts.every((part) => part.kind === "text" || part.kind === "call") &&
      (entry.end === undefined
        ? spadeQuiet.startsWith(whole.toLowerCase())
        : entry.end.kind === "finished" && isSpadeQuiet(whole));
    const grouped = inputs && onlyGroups;
    if (entry.end !== undefined) {
      inputs = false;
      onlyBeats = true;
      onlyGroups = true;
    }
    if (grouped) cardBubbles(entry, bubbles, ask);
    else if (!quiet) replyBubbles(entry, bubbles, held, ask);
    else
      for (const part of entry.parts) if (part.kind === "files") hold(held, part.key, part.paths);
  }
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
  const say = (text: string, live: boolean) => {
    pushBot(bubbles, held, {
      key: count++ ? `${entry.key}:${count}` : entry.key,
      text,
      live,
      end: undefined,
      failure: undefined,
      ...take(),
      ...at,
    });
    latest = bubbles.length - 1;
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
      if (text) say(text, false);
    } else if (part.kind === "shared") {
      images.push(...part.images);
      documents.push(...part.documents);
      attach();
    } else if (part.kind === "remembered") {
      bubbles.push({ kind: "remembered", key: `${entry.key}:${part.key}`, note: part.note });
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
  if (live) say(live, true);
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
      say("", false);
      const added = bubbles[latest];
      if (added?.kind === "bot") bubbles[latest] = { ...added, end, failure };
    }
  }
  // Media with no words before it.
  if (images.length || documents.length) {
    if (tail()) attach();
    else say("", false);
  }
  // What it did, under what it said.
  const steps = spadeReplySteps(entry);
  if (steps) bubbles.push({ kind: "steps", key: `${entry.key}:steps`, ...steps });
  // Under the finished reply, so it sits below the bot's own words about it.
  const setup = entry.parts.find((part) => part.kind === "search-setup");
  if (setup && entry.end) bubbles.push({ kind: "search-setup", key: `${entry.key}:${setup.key}` });
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
