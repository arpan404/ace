import type {
  SpadeApproval,
  SpadeEntry,
  SpadeQuestionCard,
  SpadeReplyEntry,
  SpadeRequest,
} from "./fold.ts";
import type { SpadeRememberedNote } from "./notes.ts";
import type { SpadeDocumentRef, SpadeImageRef, SpadeVoiceRef } from "./media.ts";
import type { SpadeView } from "./view.ts";
import type { SpadeFailureKind } from "./wire.ts";
import { spadeCapSentence } from "./oversight.ts";
import { spadeHelperLine } from "./helper-words.ts";
import { spadeReplySteps, spadeStepsSummary, type SpadeStep } from "./steps.ts";

/*
 * A conversation as a chat (ADR 0127): the person's messages and the bot's, nothing of how the
 * bot works. Tool calls, background jobs and compaction stay with the bot; an approval arrives
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
  /**
   * A message a group the bot is in sent here (ADR 0132): a small `In <group>` label, never the
   * person's bubble; `agent` when a member asked, not the person.
   */
  | {
      kind: "group";
      key: string;
      group: string;
      text: string;
      agent: { id: string; name: string } | undefined;
    }
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
   * The steps a reply took, as one line under its words that opens to each (`spadeReplySteps`).
   * `reply`: the reply they led to.
   */
  | { kind: "steps"; key: string; reply: string; summary: string; steps: readonly SpadeStep[] }
  /** Files a tool kept with no reply after them yet: chips on the bot's side. */
  | { kind: "files"; key: string; paths: readonly string[] }
  /** "Remembered: …": a note the bot saved or rewrote, which the person may open to edit. */
  | { kind: "remembered"; key: string; note: SpadeRememberedNote }
  /** Web search had nothing set up: a quiet line that opens Settings › Spade › Web search. */
  | { kind: "search-setup"; key: string }
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
      /** A helper's call (ADR 0152): its task. */
      helper: { job: string; task: string } | undefined;
      state: "open" | "allowed" | "denied" | "closed";
      /** Allowed always. */
      always: boolean;
    };

/** Why a reply failed, as its bubble says it. */
export interface SpadeBubbleFailure {
  kind: SpadeFailureKind;
  /** The endpoint's id, when the endpoint was to blame. */
  endpoint: string | undefined;
  /** The endpoint's or Spade's own words, for Details and the activity log. */
  error: string;
  /**
   * The person's last message, to send again with Try again: only on the conversation's last
   * reply, when the person's text-only message started it and a cap didn't stop it.
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
  const open = new Map(view.approvals.map((approval) => [approval.callId, approval]));
  const shown = new Set<string>();
  const ask = (request: SpadeRequest, key: string, at: number | undefined) => {
    shown.add(request.callId);
    bubbles.push({ ...askBubble(request, key, open.get(request.callId)), ...stamp(at) });
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
    if (entry.kind === "handback") {
      bubbles.push({ kind: "handback", key: entry.key, text: entry.text, data: entry.data });
      continue;
    }
    if (entry.kind === "helper") {
      // Its result reaches the bot like a message.
      if (entry.outcome) {
        inputs = true;
        onlyBeats = false;
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
    if (entry.kind === "cap") {
      pushBot(bubbles, held, {
        key: entry.key,
        text: spadeCapSentence(entry.scope, entry.capMicros),
        live: false,
        end: undefined,
        failure: undefined,
        images: [],
        documents: [],
      });
      continue;
    }
    if (entry.kind === "user") {
      inputs = true;
      onlyBeats &&= entry.fromRoutine?.heartbeat === true;
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
      if (entry.fromGroup) {
        bubbles.push({
          kind: "group",
          key: entry.key,
          group: entry.fromGroup.name,
          text: entry.text,
          agent: entry.fromAgent,
          ...stamp(entry.at),
        });
        continue;
      }
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
    if (entry.end !== undefined) {
      inputs = false;
      onlyBeats = true;
    }
    if (!quiet) replyBubbles(entry, bubbles, held, ask);
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
  return bubbles;
}

/** `at` as a bubble carries it: absent when unknown. */
const stamp = (at: number | undefined): { at?: number } => (at === undefined ? {} : { at });

/** A request's bubble: open while Spade still waits on it, with the newest reason it has. */
function askBubble(
  request: SpadeRequest,
  key: string,
  waiting: SpadeApproval | undefined,
): Extract<SpadeBubble, { kind: "ask" }> {
  return {
    kind: "ask",
    key: key || `ask:${request.callId}`,
    callId: request.callId,
    name: request.name,
    arguments: request.arguments,
    reason: waiting?.reason ?? request.reason,
    helper: waiting?.helper ?? request.helper,
    state: waiting ? "open" : (request.answer ?? "closed"),
    always: request.always,
  };
}

/**
 * A reply's bubbles: its words, split where it remembered a note or asked a question, each with
 * the images and documents its tools showed meanwhile after its words, and its steps folded into
 * one line under its last words. Once the reply has ended, a request the person answered is one
 * of those steps, not a bubble of its own. The first run keeps the reply's key, so a bubble keeps
 * its place as the reply grows.
 */
function replyBubbles(
  entry: SpadeReplyEntry,
  bubbles: SpadeBubble[],
  held: Held,
  ask: (request: SpadeRequest, key: string, at: number | undefined) => void,
) {
  const at = stamp(entry.startedAt);
  let words: string[] = [];
  let images: SpadeImageRef[] = [];
  let documents: SpadeDocumentRef[] = [];
  let runs = 0;
  // Where the steps line goes: after the reply's last words, or where the reply began.
  let afterWords = bubbles.length;
  const take = () => {
    const media = { images, documents };
    images = [];
    documents = [];
    return media;
  };
  const flush = () => {
    const text = words.join("\n\n").trim();
    words = [];
    if (!text && !images.length && !documents.length) return;
    pushBot(bubbles, held, {
      key: runs++ ? `${entry.key}:${runs}` : entry.key,
      text,
      live: false,
      end: undefined,
      failure: undefined,
      ...take(),
      ...at,
    });
    afterWords = bubbles.length;
  };
  for (const part of entry.parts) {
    if (part.kind === "text") words.push(part.text);
    else if (part.kind === "shared") {
      images.push(...part.images);
      documents.push(...part.documents);
    } else if (part.kind === "remembered") {
      flush();
      bubbles.push({ kind: "remembered", key: `${entry.key}:${part.key}`, note: part.note });
    } else if (part.kind === "question") {
      flush();
      bubbles.push({ ...part, key: `${entry.key}:${part.key}`, ...at });
    } else if (part.kind === "files") {
      flush();
      hold(held, part.key, part.paths);
    } else if (part.kind === "request") {
      // Answered in a reply that has ended, it reads among the reply's steps.
      if (entry.end !== undefined && part.answer !== undefined) continue;
      flush();
      ask(part, `${entry.key}:${part.key}`, entry.startedAt);
    }
  }
  if (entry.live) words.push(entry.live);
  const text = words.join("\n\n").trim();
  const end = entry.end && entry.end.kind !== "finished" ? entry.end.kind : undefined;
  // A reply with nothing more to say yet shows only as the working line.
  if (text || end || images.length || documents.length) {
    pushBot(bubbles, held, {
      key: runs ? `${entry.key}:${runs + 1}` : entry.key,
      text,
      live: entry.end === undefined,
      end,
      failure:
        entry.end?.kind === "failed"
          ? {
              kind: entry.end.failure,
              endpoint: entry.end.endpoint,
              error: entry.end.error,
              retry: undefined,
            }
          : undefined,
      ...take(),
      ...at,
    });
    afterWords = bubbles.length;
  }
  const steps = spadeReplySteps(entry);
  if (steps.length)
    bubbles.splice(afterWords, 0, {
      kind: "steps",
      key: `steps:${entry.key}`,
      reply: entry.key,
      summary: spadeStepsSummary(steps),
      steps,
      ...at,
    });
  // Under the finished reply, so it sits below the bot's own words about it.
  const setup = entry.parts.find((part) => part.kind === "search-setup");
  if (setup && entry.end) bubbles.push({ kind: "search-setup", key: `${entry.key}:${setup.key}` });
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
 * Try again on the last bubble when the conversation's last reply failed after a message the
 * person typed: that message's words, sent again. A message with pictures, files or a recording
 * isn't offered (they would be lost), nor one a routine, group or bot sent, nor a cap's failure.
 */
function offerRetry(bubbles: SpadeBubble[], entries: readonly SpadeEntry[]) {
  // The failed reply's steps line may sit under it.
  const at = bubbles.findLastIndex((bubble) => bubble.kind !== "steps");
  const last = bubbles[at];
  if (last?.kind !== "bot" || !last.failure || last.failure.kind === "cap") return;
  const reply = entries.findLastIndex((entry) => entry.kind === "reply");
  if (reply !== entries.length - 1) return;
  const asked = entries.slice(0, reply).findLast((entry) => entry.kind === "user");
  if (
    asked?.kind !== "user" ||
    asked.pending ||
    asked.fromAgent ||
    asked.fromRoutine ||
    asked.fromGroup ||
    asked.voice ||
    asked.images.length ||
    asked.documents?.length ||
    !asked.text.trim()
  )
    return;
  bubbles[at] = { ...last, failure: { ...last.failure, retry: asked.text } };
}
