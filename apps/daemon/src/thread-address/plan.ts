import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SpadeFaceJson,
  type Addressed,
  type AddressedShare,
  type AddressedState,
  type AddressedTo,
  type Addressee,
  type ContentPart,
  type Speaker,
} from "@ace/protocol";

/*
 * What a message the person addresses from a thread becomes (ADR 0194), and how Spade's answers
 * move it on. Pure: the asks driver (`asks.ts`) brings Spade's answers and writes the results.
 */

/** Spade's key for one addressee of one command: stable across retries, `[A-Za-z0-9_.:-]`. */
export function askKey(commandId: string, index: number): string {
  const digest = createHash("sha256").update(`${commandId}\n${index}`).digest("hex");
  return `ace.t.${digest.slice(0, 40)}`;
}

/** The transcript key of the person's addressed message, and of each reply posted after it. */
export const addressedItemKey = (commandId: string) => `ace-address:${commandId}`;
export const replyItemKey = (key: string, index: number) => `ace-reply:${key}:${index}`;

/** The person's words as Spade reads them: their text, with each chip as its name. */
export function personText(input: readonly ContentPart[]): string {
  return input
    .map((part) =>
      part.type === "text" ? part.text : part.type === "mention" ? (part.title ?? part.name) : "",
    )
    .join("")
    .trim();
}

/** Where every addressee starts: not delivered yet. */
export const firstState: AddressedState = "sending";

/** The person's message as the thread stores it: their parts, and who it went to. */
export function addressedDraft(
  input: readonly ContentPart[],
  to: readonly AddressedTo[],
  share: AddressedShare,
) {
  const addressed: Addressed = { to: [...to], share };
  return {
    type: "message" as const,
    role: "user" as const,
    parts: [...input],
    origin: { kind: "person" as const },
    addressed,
    complete: true,
  };
}

/** One reply as the thread stores it: the bot's words under its face, never the agent's. */
export function replyDraft(text: string, speaker: Speaker) {
  return {
    type: "message" as const,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text }],
    speaker,
    complete: true,
  };
}

/** Spade's answer to `GET /v1/thread-asks/{key}`: data from outside, read leniently. */
const Named = z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(120) });
export const ThreadAskAnswer = z.object({
  status: z.enum(["pending", "answered", "stopped", "failed", "unknown"]).catch("pending"),
  replies: z
    .array(
      z.object({
        bot: Named.extend({ avatar: SpadeFaceJson.optional().catch(undefined) }),
        text: z.string().max(256 * 1024),
      }),
    )
    .max(64)
    .catch([]),
  answering: z.array(Named).max(16).catch([]),
  waiting: z.array(Named).max(16).catch([]),
  text: z.string().max(2048).optional().catch(undefined),
});
export type ThreadAskAnswer = z.infer<typeof ThreadAskAnswer>;

/** What one answer changes: the addressee's state, and the replies not posted yet. */
export interface AskProgress {
  state: AddressedState;
  detail?: string | undefined;
  replies: readonly { speaker: Speaker; text: string }[];
  done: boolean;
}

/**
 * Reads Spade's answer for an addressee whose first `posted` replies are already in the
 * thread. An unknown key after delivery means Spade lost it (a reset home): it fails, said so.
 */
export function askProgress(
  to: Extract<Addressee, { kind: "bot" | "club" }>,
  answer: ThreadAskAnswer,
  posted: number,
  inReplyTo: string,
): AskProgress {
  const club = to.kind === "club" ? { id: to.id, name: to.name } : undefined;
  const replies = answer.replies.slice(posted).map((reply) => ({
    text: reply.text,
    speaker: {
      kind: "bot" as const,
      id: reply.bot.id,
      name: reply.bot.name,
      ...(reply.bot.avatar !== undefined ? { avatar: reply.bot.avatar } : {}),
      ...(club ? { club } : {}),
      inReplyTo,
    },
  }));
  const said = answer.text?.trim() || undefined;
  switch (answer.status) {
    case "answered":
      return { state: "answered", replies, done: true };
    case "stopped":
      return { state: "stopped", detail: said, replies, done: true };
    case "failed":
      return {
        state: "failed",
        detail: said ?? `${to.name} couldn't answer.`,
        replies,
        done: true,
      };
    case "unknown":
      return {
        state: "failed",
        detail: "Spade no longer has this message.",
        replies,
        done: true,
      };
    case "pending":
      return {
        state: answer.waiting.length ? "waiting" : "answering",
        replies,
        done: false,
      };
  }
}

/** The background row's words while an addressee works: what the thread's Work list shows. */
export function holdTitle(to: Addressee): string {
  return to.kind === "agent" ? `Sending to ${to.title}` : `${to.name} is answering`;
}
