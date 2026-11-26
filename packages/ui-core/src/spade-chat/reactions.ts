import { z } from "zod";

/*
 * Reactions (spade/docs/chat-core.md, "Messages, ids and replies"): one standing emoji per reactor
 * on a message, stored as `reaction` events and folded to the latest per reactor. The person's goes
 * in through the reactions API; a bot's comes from `<react to="m12">👍</react>` in its words (with
 * `agent` naming the member bot in a club).
 */

/** The six the picker offers first. */
export const spadeQuickReactions = ["👍", "❤️", "😂", "😮", "🙏", "👎"] as const;

/** One emoji on a message and who put it there, in first-reacted order. */
export interface SpadeReactionGroup {
  emoji: string;
  /** Reactor ids: `"person"`, `"bot"` (in a bot's own chat), or a club member's agent id. */
  by: string[];
}

/** What each side (and in a club, each member bot by agent id) has put on one message. */
export interface SpadeMessageReactions {
  person?: string;
  bot?: string;
  /** Club member reactions keyed by agent id. */
  agents?: Record<string, string>;
  /** Reactor keys in the order they last reacted (`"person"`, `"bot"`, or agent id). */
  order?: string[];
}

export const spadeReactionEvents = [
  z.object({
    type: z.literal("reaction"),
    /** The message's id (`m12`, `m12.3`). */
    message: z.string().min(1).max(40),
    /** Empty on a take-back of a reaction Spade had no record of. */
    emoji: z.string().max(32).catch(""),
    by: z.enum(["person", "bot"]).catch("bot"),
    /** The reacting bot's agent id in a club; absent for the person and a bot's own chat. */
    agent: z.string().min(1).max(64).optional().catch(undefined),
    removed: z.boolean().catch(false).optional(),
  }),
] as const;

/** Fold one reaction event into the map, in place: the latest per reactor, removed clears it. */
export function spadeFoldReaction(
  into: Map<string, SpadeMessageReactions>,
  event: {
    message: string;
    emoji: string;
    by: "person" | "bot";
    agent?: string | undefined;
    removed?: boolean | undefined;
  },
): void {
  const prev = into.get(event.message);
  const now: SpadeMessageReactions = {
    ...(prev?.person !== undefined ? { person: prev.person } : {}),
    ...(prev?.bot !== undefined ? { bot: prev.bot } : {}),
    ...(prev?.agents ? { agents: { ...prev.agents } } : {}),
    ...(prev?.order ? { order: [...prev.order] } : {}),
  };
  const key = event.by === "bot" && event.agent ? event.agent : event.by;
  const order = (now.order ?? []).filter((who) => who !== key);
  const clearing = Boolean(event.removed) || event.emoji === "";
  if (event.by === "bot" && event.agent) {
    if (clearing) {
      if (now.agents) {
        delete now.agents[event.agent];
        if (Object.keys(now.agents).length === 0) delete now.agents;
      }
    } else {
      now.agents = { ...now.agents, [event.agent]: event.emoji };
      order.push(key);
    }
  } else if (clearing) {
    delete now[event.by];
  } else {
    now[event.by] = event.emoji;
    order.push(key);
  }
  if (order.length > 0) now.order = order;
  else delete now.order;
  const hasAgents = now.agents !== undefined && Object.keys(now.agents).length > 0;
  if (now.person === undefined && now.bot === undefined && !hasAgents) into.delete(event.message);
  else into.set(event.message, now);
}

/** Group standing reactions across one or more message entries into `{ emoji, by[] }` chips. */
export function spadeAggregateReactions(
  entries: readonly (SpadeMessageReactions | undefined)[],
): SpadeReactionGroup[] {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!entry) continue;
    const keys = entry.order ?? [
      ...(entry.person !== undefined ? ["person"] : []),
      ...(entry.bot !== undefined ? ["bot"] : []),
      ...Object.keys(entry.agents ?? {}),
    ];
    for (const who of keys) {
      if (seen.has(who)) continue;
      const emoji =
        who === "person" ? entry.person : who === "bot" ? entry.bot : entry.agents?.[who];
      if (emoji) seen.set(who, emoji);
    }
  }
  const groups: SpadeReactionGroup[] = [];
  for (const [who, emoji] of seen) {
    const existing = groups.find((group) => group.emoji === emoji);
    if (existing) existing.by.push(who);
    else groups.push({ emoji, by: [who] });
  }
  return groups;
}
