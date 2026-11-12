import type { SpadeReplyEntry } from "./fold.ts";
import type { SpadeRememberedNote } from "./notes.ts";
import type { SpadeImageRef } from "./wire.ts";
import type { SpadeView } from "./view.ts";
import { spadeCapSentence } from "./oversight.ts";

/*
 * A conversation as a chat (ADR 0127): the person's messages and the bot's, nothing of how the
 * bot works. Tool calls, background jobs and compaction stay with the bot; an approval arrives
 * as a bubble of the bot's that the person answers, a question as the bot's bubble (ADR 0128),
 * and a note the bot saved as one quiet line between its bubbles.
 */
export type SpadeBubble =
  | {
      kind: "person";
      key: string;
      text: string;
      images: readonly SpadeImageRef[];
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
      error: string | undefined;
      /** Workspace files a tool kept since the bot's last bubble: chips that open each. */
      files?: readonly string[];
    }
  /** Files a tool kept with no reply after them yet: chips on the bot's side. */
  | { kind: "files"; key: string; paths: readonly string[] }
  /** "Remembered: …": a note the bot saved or rewrote, which the person may open to edit. */
  | { kind: "remembered"; key: string; note: SpadeRememberedNote }
  /** `name`: the tool it asks to use, for `spadeApprovalSentence` with the bot's name. */
  | {
      kind: "ask";
      key: string;
      callId: string;
      name: string;
      sentence: string;
      /** What the call would do, as the bot sent it: shown on request before the answer. */
      arguments: unknown;
      /** Why the model review asked the person: "Asked you because: …". */
      reason: string | undefined;
    };

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
  for (const entry of view.entries) {
    if (entry.kind === "job") {
      inputs = true;
      onlyBeats = false;
      hold(held, entry.key, entry.files);
    }
    if (entry.kind === "cap") {
      pushBot(bubbles, held, {
        key: entry.key,
        text: spadeCapSentence(entry.scope, entry.capMicros),
        live: false,
        end: undefined,
        error: undefined,
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
        });
        continue;
      }
      bubbles.push(
        entry.fromAgent
          ? { kind: "other", key: entry.key, agent: entry.fromAgent, text: entry.text }
          : {
              kind: "person",
              key: entry.key,
              text: entry.text,
              images: entry.images,
              sending: entry.pending === true,
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
      entry.parts.every((part) => part.kind !== "remembered" && part.kind !== "question") &&
      (entry.end === undefined
        ? spadeQuiet.startsWith(whole.toLowerCase())
        : entry.end.kind === "finished" && isSpadeQuiet(whole));
    if (entry.end !== undefined) {
      inputs = false;
      onlyBeats = true;
    }
    if (!quiet) replyBubbles(entry, bubbles, held);
    else
      for (const part of entry.parts) if (part.kind === "files") hold(held, part.key, part.paths);
  }
  if (held.key !== undefined && held.paths.length)
    bubbles.push({ kind: "files", key: `files:${held.key}`, paths: held.paths });
  for (const approval of view.approvals)
    bubbles.push({
      kind: "ask",
      key: `ask:${approval.callId}`,
      callId: approval.callId,
      name: approval.name,
      arguments: approval.arguments,
      sentence: approval.sentence,
      reason: approval.reason,
    });
  return bubbles;
}

/**
 * A reply's bubbles: its words, split where it remembered a note or asked a question. The first
 * run keeps the reply's key, so a bubble keeps its place as the reply grows.
 */
function replyBubbles(entry: SpadeReplyEntry, bubbles: SpadeBubble[], held: Held) {
  let words: string[] = [];
  let runs = 0;
  const flush = () => {
    const text = words.join("\n\n").trim();
    words = [];
    if (!text) return;
    pushBot(bubbles, held, {
      key: runs++ ? `${entry.key}:${runs}` : entry.key,
      text,
      live: false,
      end: undefined,
      error: undefined,
    });
  };
  for (const part of entry.parts) {
    if (part.kind === "text") words.push(part.text);
    else if (part.kind === "remembered") {
      flush();
      bubbles.push({ kind: "remembered", key: `${entry.key}:${part.key}`, note: part.note });
    } else if (part.kind === "question") {
      flush();
      words.push(part.text);
      flush();
    } else if (part.kind === "files") {
      flush();
      hold(held, part.key, part.paths);
    }
  }
  if (entry.live) words.push(entry.live);
  const text = words.join("\n\n").trim();
  const end = entry.end && entry.end.kind !== "finished" ? entry.end.kind : undefined;
  // A reply with nothing more to say yet shows only as the working line.
  if (!text && !end) return;
  pushBot(bubbles, held, {
    key: runs ? `${entry.key}:${runs + 1}` : entry.key,
    text,
    live: entry.end === undefined,
    end,
    error: entry.end?.kind === "failed" ? entry.end.error : undefined,
  });
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
  bubble: Omit<Extract<SpadeBubble, { kind: "bot" }>, "kind" | "files">,
) {
  const files = held.paths.length ? { files: held.paths.slice() } : {};
  held.paths.length = 0;
  held.key = undefined;
  bubbles.push({ kind: "bot", ...bubble, ...files });
}
