import { z } from "zod";
import { initials } from "../profile.ts";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Spade's agents (ADR 0126, 0127): Spade itself, the main bot, and the person's bots, each a name,
 * a task, an avatar and a model, with exactly one conversation. Parsed leniently: an agent this client can't read is left out of the list, a
 * field it doesn't know stays in `raw`, and an avatar it can't read becomes a generated one.
 */

/** The colours a generated avatar may use, in the order the picker offers them. */
export const spadeAvatarColors = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;
export type SpadeAvatarColor = (typeof spadeAvatarColors)[number];

export type SpadeAvatar =
  /** The main bot's face: the Spade mark. */
  | { kind: "spade" }
  /** An uploaded image, its bytes at `GET /v1/images/{sha256}`. */
  | { kind: "image"; sha256: string }
  | { kind: "generated"; initials: string; color: SpadeAvatarColor };

/** What an agent is doing: nothing, working, or waiting on the person (an approval, a question). */
export type SpadeAgentState = "idle" | "working" | "waiting";

/** The latest message in an agent's conversation, for its roster row. */
export interface SpadeLastMessage {
  from: "person" | "agent";
  text: string;
  at: number;
  /** Another bot that sent it into this conversation. */
  fromAgent: string | undefined;
}

export interface SpadeAgent {
  id: string;
  /** `main`: Spade itself, which always exists and can't be deleted. */
  kind: "main" | "bot";
  name: string;
  /** What the agent is for, in the person's words: its instructions. */
  task: string;
  avatar: SpadeAvatar;
  /** `endpoint/model`. */
  model: string;
  /** Its one conversation's id, for the conversation routes. */
  conversation: string;
  createdAt: number;
  updatedAt: number;
  lastActivity: number;
  state: SpadeAgentState;
  /** A few words on what it is doing now, while it works. */
  status: string | undefined;
  lastMessage: SpadeLastMessage | undefined;
  /** The agent as Spade sent it, fields this client doesn't know included. */
  raw: Record<string, unknown>;
}

const color = z.enum(spadeAvatarColors);
const avatarShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spade") }),
  z.object({ kind: z.literal("image"), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ kind: z.literal("generated"), initials: z.string().nullish(), color: z.unknown() }),
]);

const time = z.number().catch(0);
const lastMessageShape = z.object({
  from: z.enum(["person", "agent"]).catch("agent"),
  text: z.string().catch(""),
  at: time.default(0),
  from_agent: z.string().nullish().catch(undefined),
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
  state: z.enum(["idle", "working", "waiting"]).optional().catch(undefined),
  /** Before 0127 Spade said only whether it worked. */
  working: z.boolean().optional().catch(undefined),
  status: z.string().nullish().catch(undefined),
  last_message: lastMessageShape.nullish().catch(undefined),
});

function avatarOf(raw: unknown, name: string, main: boolean): SpadeAvatar {
  // The main bot's face is always the Spade mark.
  if (main) return { kind: "spade" };
  const parsed = avatarShape.safeParse(raw);
  if (parsed.success && parsed.data.kind === "image") return parsed.data;
  if (parsed.success && parsed.data.kind === "spade") return { kind: "spade" };
  const generated = parsed.success && parsed.data.kind === "generated" ? parsed.data : undefined;
  const picked = color.safeParse(generated?.color);
  return {
    kind: "generated",
    initials: generated?.initials || initials(name) || "?",
    color: picked.success ? picked.data : "slate",
  };
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
    avatar: avatarOf(agent.avatar, agent.name, main),
    model: agent.model,
    conversation: agent.conversation,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
    lastActivity: agent.last_activity,
    state: agent.state ?? (agent.working ? "working" : "idle"),
    status: agent.status || undefined,
    lastMessage: last
      ? { from: last.from, text: last.text, at: last.at, fromAgent: last.from_agent ?? undefined }
      : undefined,
    raw: record,
  };
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
