import { z } from "zod";
import { faceForId, parseStoredBotFace, storedBotFace, type BotFace } from "../bot-face/index.ts";
import { spadeJson, spadeRecord } from "./json.ts";
import { parseSpadeComputer, type SpadeComputer } from "./computer.ts";
import { parseSpadeReview, parseSpadeSpending, type SpadeSpending } from "./oversight.ts";
import { parseSpadePackage, type SpadePackage } from "./packages.ts";
import { parseSpadeTaskProgress, type SpadeTaskProgress } from "./autonomy.ts";
import { parseSpadeArrival, parseSpadeMove, type SpadeArrival, type SpadeMove } from "./moves.ts";

/*
 * Spade's agents (ADR 0126, 0127): Spade itself, the main bot, and the person's bots, each a name,
 * a task, an avatar and a model, with exactly one conversation. Parsed leniently: an agent this client can't read is left out of the list, a
 * field it doesn't know stays in `raw`, and an avatar it can't read becomes the face its id seeds.
 */

export type SpadeAvatar =
  /** The main bot's face: the Spade mark. */
  | { kind: "spade" }
  /** An uploaded image, its bytes at `GET /v1/images/{sha256}`. */
  | { kind: "image"; sha256: string }
  /** A character face; `raw` keeps the stored fields this client doesn't know. */
  | { kind: "character"; face: BotFace; raw: Record<string, unknown> };

/**
 * What an agent is doing: nothing, working, waiting on the person (an approval, a question), or
 * paused by them (ADR 0200 §6.1). A sleeping bot reads `working` here: never idle or done.
 */
/** `updating`: its package update or rollback is being applied (ADR 0200 §6.2); it works. */
export type SpadeAgentState = "idle" | "working" | "waiting" | "paused" | "updating";

/** The latest message in an agent's conversation, for its roster row. */
export interface SpadeLastMessage {
  from: "person" | "agent";
  text: string;
  at: number;
  /** Its event in the conversation; undefined from a Spade before seen cursors. */
  seq: number | undefined;
  /** Another bot that sent it into this conversation (`from` is then `person`). */
  fromAgent: { id: string; name: string } | undefined;
}

export type SpadeMayCreate = "yes" | "ask" | "no";

const madeByShape = z.object({
  id: z.string(),
  name: z.string().catch(""),
  apps: z.array(z.string()).catch([]).default([]),
});

export interface SpadeAgent {
  id: string;
  /** `main`: Spade itself, which always exists and can't be deleted. */
  kind: "main" | "bot";
  name: string;
  /** What the agent is for, in the person's words: its instructions. */
  task: string;
  avatar: SpadeAvatar;
  /** `endpoint/model`, or `cli:<provider>[@<account>]/<model>` on a subscription. */
  model: string;
  /** Its one conversation's id, for the conversation routes. */
  conversation: string;
  createdAt: number;
  updatedAt: number;
  lastActivity: number;
  /** When the person pinned it (ms); undefined when it isn't pinned. */
  pinnedAt: number | undefined;
  state: SpadeAgentState;
  /** What it waits on the person for while `waiting`: an approval, or a question. */
  waitingFor: "approval" | "question" | undefined;
  /** Its cards the person left for later and hasn't answered or dismissed (ADR 0154). */
  questionsForLater: number;
  /** A few words on what it is doing now, while it works. */
  status: string | undefined;
  /** Why its latest reply on a subscription failed (signed out, out of quota), until one works. */
  problem: string | undefined;
  /**
   * Its subscription's maker no longer allows this (ADR 0205 §4): it waits for the person to pick
   * one of `choices` (their own models) or another. Undefined while it isn't held.
   */
  termsHold: SpadeTermsHold | undefined;
  lastMessage: SpadeLastMessage | undefined;
  /** The conversation's seen cursor: the last event the person has seen; undefined when never marked. */
  seenSeq: number | undefined;
  /** It finished and the person hasn't seen it since: never while it works or waits on them. */
  unseen: boolean;
  /** Its spend (ADR 0135), information only; undefined from a Spade before it. */
  spending: SpadeSpending | undefined;
  /** Its own model review switch; undefined follows the default. */
  review: boolean | undefined;
  /** Its computer and who drives it; undefined from a Spade before computers. */
  computer: SpadeComputer | undefined;
  /** Where it is on its task, and whether it carries on by itself. */
  progress: SpadeTaskProgress | undefined;
  /** The bot that made it as a worker (ADR 0161); undefined when the person made it. */
  parent: { id: string; name: string } | undefined;
  /** Its move to another machine while one runs, or one that failed (ADR 0187). */
  move: SpadeMove | undefined;
  /** What needs the person since it arrived from another machine, until dismissed. */
  arrived: SpadeArrival | undefined;
  /**
   * It is in Full access (ADR 0163, amendment 2): no reviewer, and only the hard stops ask. False
   * on the auto-review, every bot's default, and from a Spade before Full access.
   */
  fullAccess: boolean;
  /** The agent as Spade sent it, fields this client doesn't know included. */
  raw: Record<string, unknown>;
  /**
   * Whether it may make bots for the person (ADR 0161, amendment 1): `yes`, `ask` (the person
   * agrees to each) or `no`. Spade's starts on `yes`, every other bot's on `ask`.
   */
  mayCreateBots: SpadeMayCreate;
  /** The bot that made it, when one did, with the apps it suggested. */
  madeBy: { id: string; name: string; apps: readonly string[] } | undefined;
  /** Undo archived it: it had acted, so it was kept, stopped, its routines paused. */
  archived: boolean;
  /** The agent package it is linked to (ADR 0200 §3.9), shown in its profile. */
  package?: SpadePackage | undefined;
  /**
   * Its accent (ADR 0200 §5.3): its package's `style.accent`, or the person's choice (`chosen`),
   * where `accent` undefined means its face's colour. Undefined when it has none.
   */
  style?: SpadeAgentStyle | undefined;
}

export interface SpadeAgentStyle {
  accent: string | undefined;
  chosen: boolean;
}

const styleShape = z.object({
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .transform((hex) => hex.toLowerCase())
    .nullish()
    .catch(undefined),
  chosen: z.boolean().catch(false).default(false),
});

const avatarShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spade") }),
  z.object({ kind: z.literal("image"), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);

const time = z.number().catch(0);
const lastMessageShape = z.object({
  from: z.enum(["person", "agent"]).catch("agent"),
  text: z.string().catch(""),
  at: time.default(0),
  seq: z.number().int().nonnegative().nullish().catch(undefined),
  from_agent: z
    .object({ id: z.string(), name: z.string().catch("") })
    .nullish()
    .catch(undefined),
});
const agentShape = z.object({
  id: z.string().min(1),
  kind: z.enum(["main", "bot"]).catch("bot").default("bot"),
  name: z.string().catch(""),
  task: z.string().nullish().catch(""),
  avatar: z.unknown().optional(),
  model: z.string().catch(""),
  conversation: z.string().min(1),
  created_at: time.default(0),
  updated_at: time.default(0),
  last_activity: time.default(0),
  pinned_at: z.number().nullish().catch(undefined),
  state: z.enum(["idle", "working", "waiting", "paused", "updating"]).optional().catch(undefined),
  waiting_for: z.enum(["approval", "question"]).nullish().catch(undefined),
  questions_for_later: z.number().int().nonnegative().nullish().catch(undefined),
  /** Before 0127 Spade said only whether it worked. */
  working: z.boolean().optional().catch(undefined),
  status: z.string().nullish().catch(undefined),
  problem: z.string().nullish().catch(undefined),
  terms_hold: z
    .object({
      provider: z.string().catch(""),
      name: z.string().catch(""),
      text: z.string().min(1),
      choices: z.array(z.string().min(1)).catch([]),
    })
    .nullish()
    .catch(undefined),
  last_message: lastMessageShape.nullish().catch(undefined),
  seen_seq: z.number().int().nonnegative().nullish().catch(undefined),
  unseen: z.boolean().catch(false).default(false),
  parent: z
    .object({ id: z.string().min(1), name: z.string().catch("") })
    .nullish()
    .catch(undefined),
});

function avatarOf(raw: unknown, seed: string, main: boolean): SpadeAvatar {
  // The main bot's face is always the Spade mark.
  if (main) return { kind: "spade" };
  const parsed = avatarShape.safeParse(raw);
  if (parsed.success) return parsed.data;
  const stored = parseStoredBotFace(raw);
  if (stored) return { kind: "character", ...stored };
  // Initials from a Spade before faces, or anything unreadable: the face the id seeds, as
  // Spade's own migration picks it.
  const face = faceForId(seed);
  return { kind: "character", face, raw: storedBotFace(face) };
}

/**
 * A bot's face as Spade sent it anywhere (a group member's, say), `seed` its agent id: a
 * character face repaired, else the face that id seeds.
 */
export function parseSpadeAvatar(raw: unknown, seed: string): SpadeAvatar {
  return avatarOf(raw, seed, false);
}

/** Why a bot on a subscription waits, and the person's own models it could move to. */
export interface SpadeTermsHold {
  provider: string;
  name: string;
  /** "Codex's terms no longer allow this. Pick another model for this bot." */
  text: string;
  /** `endpoint/model`s, the bot's route first. */
  choices: string[];
}

/** One agent value; undefined when it has no id or no conversation. */
export function parseSpadeAgentValue(raw: unknown): SpadeAgent | undefined {
  const parsed = agentShape.safeParse(raw);
  const record = spadeRecord(raw);
  if (!parsed.success || !record) return undefined;
  const agent = parsed.data;
  const main = agent.kind === "main";
  const last = agent.last_message;
  return {
    id: agent.id,
    kind: agent.kind,
    name: main ? "Spade" : agent.name || "Bot",
    task: agent.task ?? "",
    avatar: avatarOf(agent.avatar, agent.id, main),
    model: agent.model,
    conversation: agent.conversation,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
    lastActivity: agent.last_activity,
    pinnedAt: agent.pinned_at ?? undefined,
    state: agent.state ?? (agent.working ? "working" : "idle"),
    waitingFor: agent.waiting_for ?? undefined,
    questionsForLater: agent.questions_for_later ?? 0,
    status: agent.status || undefined,
    problem: agent.problem || undefined,
    termsHold: agent.terms_hold ?? undefined,
    lastMessage: last
      ? {
          from: last.from,
          text: last.text,
          at: last.at,
          seq: last.seq ?? undefined,
          fromAgent: last.from_agent ?? undefined,
        }
      : undefined,
    seenSeq: agent.seen_seq ?? undefined,
    unseen: agent.unseen,
    spending: parseSpadeSpending(record.spending),
    review: parseSpadeReview(record.review),
    computer: parseSpadeComputer(record.computer),
    progress: parseSpadeTaskProgress(record),
    parent: agent.parent ?? undefined,
    move: parseSpadeMove(record.move),
    arrived: parseSpadeArrival(record.arrived),
    fullAccess: record.autonomy === "full_access",
    mayCreateBots:
      record.may_create_bots === "yes" || record.may_create_bots === "no"
        ? record.may_create_bots
        : record.may_create_bots === "ask"
          ? "ask"
          : main
            ? "yes"
            : "ask",
    madeBy: madeByShape.safeParse(record.made_by).data,
    archived: record.archived === true,
    package: parseSpadePackage(record.package),
    style: main ? undefined : spadeAgentStyle(record.style),
    raw: record,
  };
}

function spadeAgentStyle(raw: unknown): SpadeAgentStyle | undefined {
  const parsed = styleShape.safeParse(raw).data;
  if (!parsed || (!parsed.accent && !parsed.chosen)) return undefined;
  return { accent: parsed.accent ?? undefined, chosen: parsed.chosen };
}

/** `GET /v1/agents`: the agents as Spade orders them; undefined when the body has no list. */
export function parseSpadeAgents(body: string): SpadeAgent[] | undefined {
  const list = spadeRecord(spadeJson(body))?.agents;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const agent = parseSpadeAgentValue(raw);
    return agent ? [agent] : [];
  });
}

/** `{"agent": ...}` from creating or editing one. */
export function parseSpadeAgent(body: string): SpadeAgent | undefined {
  return parseSpadeAgentValue(spadeRecord(spadeJson(body))?.agent);
}

/** Spade first, then the bots by latest activity, newest first. */
export function spadeRoster<T extends Pick<SpadeAgent, "kind" | "lastActivity">>(
  agents: readonly T[],
): T[] {
  return agents.toSorted(
    (a, b) =>
      Number(b.kind === "main") - Number(a.kind === "main") || b.lastActivity - a.lastActivity,
  );
}

/** `endpoint/model` in its two parts; a model id may hold slashes, an endpoint id doesn't. */
export function splitSpadeModel(ref: string): { endpoint: string; model: string } {
  const at = ref.indexOf("/");
  return at < 0
    ? { endpoint: "", model: ref }
    : { endpoint: ref.slice(0, at), model: ref.slice(at + 1) };
}

export const spadeAgentNameMax = 40;
export const spadeAgentTaskMax = 4000;

/** `POST /v1/agents/{id}/undo-made`: what Undo did to a made bot; undefined when unreadable. */
export function parseSpadeUndone(body: string): "removed" | "archived" | undefined {
  const undone = spadeRecord(spadeJson(body))?.undone;
  return undone === "removed" || undone === "archived" ? undone : undefined;
}
