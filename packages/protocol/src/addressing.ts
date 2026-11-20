import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

/*
 * A message the person addresses from an ace thread to a Spade bot, a club or another thread's
 * agent, and the replies posted back in the thread (ADR 0194). Every field here rides on
 * ordinary message items as optional fields, so a client that doesn't know them shows plain
 * text and never refuses the frame.
 */

const spadeId = z.string().min(1).max(128);
const shownName = z.string().min(1).max(120);

/**
 * A Spade face as Spade's API gives it (`{kind: "character", …}`, `{kind: "image", sha256}`,
 * `{kind: "spade"}`). Kept as Spade sent it, bounded; clients read it with `parseSpadeAvatar`.
 */
export const SpadeFaceJson = z
  .json()
  .refine((value) => JSON.stringify(value).length <= 2048, "A face is at most 2 KiB");
export type SpadeFaceJson = z.infer<typeof SpadeFaceJson>;

export const Addressee = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bot"),
    id: spadeId,
    name: shownName,
    avatar: SpadeFaceJson.optional(),
  }),
  z.object({
    kind: z.literal("club"),
    id: spadeId,
    name: shownName,
    /** The first members' faces, for the stacked picture. */
    faces: z
      .array(z.object({ id: spadeId, avatar: SpadeFaceJson.optional() }))
      .max(3)
      .default([]),
  }),
  z.object({
    kind: z.literal("agent"),
    threadId: ThreadId,
    title: z.string().max(256),
    provider: ProviderKind.optional(),
  }),
]);
export type Addressee = z.infer<typeof Addressee>;

/** What goes with the message: a summary of this thread, or only the person's words. */
export const AddressedShare = z.enum(["thread", "message"]);
export type AddressedShare = z.infer<typeof AddressedShare>;

/**
 * Where one addressee's part of the message stands: `sending` until delivered, `queued` while
 * Spade can't be reached, `answering`, `waiting` (on the person, in Spade), then `answered`,
 * `stopped` or `failed`. A message to an agent ends `sent` once that thread took it.
 */
export const AddressedState = z.enum([
  "sending",
  "queued",
  "answering",
  "waiting",
  "answered",
  "stopped",
  "failed",
  "sent",
]);
export type AddressedState = z.infer<typeof AddressedState>;

export const AddressedTo = z.object({
  to: Addressee,
  state: AddressedState,
  /** Why it failed or stopped, in words for the person. */
  detail: z.string().max(512).optional(),
});
export type AddressedTo = z.infer<typeof AddressedTo>;

/** On a reply ace posted in the thread: the bot that said it, and its club when it answered in one. */
export const Speaker = z.object({
  kind: z.literal("bot"),
  id: spadeId,
  name: shownName,
  avatar: SpadeFaceJson.optional(),
  club: z.object({ id: spadeId, name: shownName }).optional(),
  /** The person's message it answers, as `AskedLine.about` names it. */
  about: z.string().min(1).max(256),
  /** The ask it answers, for a follow-up's `thread.address`. */
  ask: z.string().min(1).max(160).optional(),
});
export type Speaker = z.infer<typeof Speaker>;

/** On a message the person sent from another thread (`@` an agent): that thread. */
export const MessageVia = z.object({
  threadId: ThreadId,
  title: z.string().max(256).optional(),
});
export type MessageVia = z.infer<typeof MessageVia>;
