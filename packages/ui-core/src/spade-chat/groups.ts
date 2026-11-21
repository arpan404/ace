import { z } from "zod";
import {
  parseSpadeAgentValue,
  parseSpadeAvatar,
  type SpadeAgent,
  type SpadeAgentState,
  type SpadeAvatar,
} from "./agents.ts";
import { faceForId, parseStoredBotFace, type BotFace } from "../bot-face/index.ts";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Spade's teams (ADR 0132, spade/docs/teams.md): groups of bots with their own transcript,
 * templates to start a bot from, and the bot file export and import write. Parsed leniently: a
 * group this client can't read is left out of the list, an unreadable face becomes the one its id seeds.
 */

/** A bot as a group names it: `machine` is its host id, null for the group's own machine. */
export interface SpadeGroupBot {
  id: string;
  name: string;
  machine: string | null;
}

export interface SpadeGroupMember {
  agent: string;
  machine: string | null;
  /** What the bot last answered with, kept while its machine is away. */
  name: string;
  avatar: SpadeAvatar;
  /** Its machine can't be reached now. */
  away: boolean;
}

export interface SpadeGroupLastMessage {
  from: "person" | "agent";
  text: string;
  at: number;
  /** Its event in the conversation; undefined from a Spade before seen cursors. */
  seq: number | undefined;
  agent: SpadeGroupBot | undefined;
}

export interface SpadeGroup {
  id: string;
  name: string;
  lead: SpadeGroupMember;
  /** The lead included, in the order the person chose. */
  members: SpadeGroupMember[];
  conversation: string;
  createdAt: number;
  updatedAt: number;
  lastActivity: number;
  /** When the person pinned it (ms); undefined when it isn't pinned. */
  pinnedAt: number | undefined;
  state: SpadeAgentState;
  /** A few words while it isn't idle: `Research is answering`. */
  status: string | undefined;
  lastMessage: SpadeGroupLastMessage | undefined;
  /** The conversation's seen cursor: the last event the person has seen; undefined when never marked. */
  seenSeq: number | undefined;
  /** It finished and the person hasn't seen it since: never while it works or waits on them. */
  unseen: boolean;
}

const time = z.number().catch(0);
const machine = z.string().nullish().catch(null);
export const spadeGroupBotShape = z
  .object({ id: z.string().min(1), name: z.string().catch(""), machine })
  .transform((bot): SpadeGroupBot => ({
    id: bot.id,
    name: bot.name,
    machine: bot.machine ?? null,
  }));

const memberShape = z.object({
  agent: z.string().min(1),
  machine,
  name: z.string().catch(""),
  avatar: z.unknown().optional(),
  away: z.boolean().catch(false).default(false),
});

const groupShape = z.object({
  id: z.string().min(1),
  name: z.string().catch(""),
  lead: memberShape,
  members: z.array(z.unknown()).catch([]),
  conversation: z.string().min(1),
  created_at: time.default(0),
  updated_at: time.default(0),
  last_activity: time.default(0),
  pinned_at: z.number().nullish().catch(undefined),
  state: z.enum(["idle", "working", "waiting"]).catch("idle").default("idle"),
  status: z.string().nullish().catch(undefined),
  last_message: z
    .object({
      from: z.enum(["person", "agent"]).catch("agent"),
      text: z.string().catch(""),
      at: time.default(0),
      seq: z.number().int().nonnegative().nullish().catch(undefined),
      agent: spadeGroupBotShape.nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
  seen_seq: z.number().int().nonnegative().nullish().catch(undefined),
  unseen: z.boolean().catch(false).default(false),
});

function memberOf(member: z.infer<typeof memberShape>): SpadeGroupMember {
  const name = member.name || "Bot";
  return {
    agent: member.agent,
    machine: member.machine ?? null,
    name,
    avatar: parseSpadeAvatar(member.avatar, member.agent),
    away: member.away,
  };
}

/** One group value; undefined when it has no id, lead or conversation. */
export function parseSpadeGroupValue(raw: unknown): SpadeGroup | undefined {
  const parsed = groupShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const group = parsed.data;
  const members = group.members.flatMap((value) => {
    const member = memberShape.safeParse(value);
    return member.success ? [memberOf(member.data)] : [];
  });
  const last = group.last_message;
  return {
    id: group.id,
    name: group.name || "Club",
    lead: memberOf(group.lead),
    members,
    conversation: group.conversation,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
    lastActivity: group.last_activity,
    pinnedAt: group.pinned_at ?? undefined,
    state: group.state,
    status: group.status || undefined,
    lastMessage: last
      ? {
          from: last.from,
          text: last.text,
          at: last.at,
          seq: last.seq ?? undefined,
          agent: last.agent ?? undefined,
        }
      : undefined,
    seenSeq: group.seen_seq ?? undefined,
    unseen: group.unseen,
  };
}

/** `GET /v1/groups`; undefined when the body has no list. */
export function parseSpadeGroups(body: string): SpadeGroup[] | undefined {
  const list = spadeRecord(spadeJson(body))?.groups;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const group = parseSpadeGroupValue(raw);
    return group ? [group] : [];
  });
}

/** `{"group": ...}` from creating or editing one. */
export function parseSpadeGroup(body: string): SpadeGroup | undefined {
  return parseSpadeGroupValue(spadeRecord(spadeJson(body))?.group);
}

/** The second line of a group's row: what it does now, else its latest message. */
export function spadeGroupLine(group: SpadeGroup): {
  text: string;
  tone?: "working" | "needs-you";
} {
  if (group.state === "waiting")
    return { text: group.status ?? "Waiting for you", tone: "needs-you" };
  if (group.state === "working") return { text: group.status ?? "Working", tone: "working" };
  const last = group.lastMessage;
  // Until the first message: who is in it.
  if (!last?.text) return { text: group.members.map((member) => member.name).join(", ") };
  if (last.from === "person") return { text: `You: ${last.text}` };
  return { text: last.agent ? `${last.agent.name}: ${last.text}` : last.text };
}

/** A file a member made answering the group, for the group's Library (`GET /v1/groups/{id}/files`). */
export interface SpadeGroupFile {
  /** The member's agent id on the group's machine; the file is in its workspace. */
  agent: string;
  path: string;
  /** When it was last written there. */
  at: number;
}

const groupFileShape = z.object({ agent: z.string().min(1), path: z.string().min(1), at: time });

/** `GET /v1/groups/{id}/files`, newest first as Spade sends them; undefined when the body has no list. */
export function parseSpadeGroupFiles(body: string): SpadeGroupFile[] | undefined {
  const list = spadeRecord(spadeJson(body))?.files;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const file = groupFileShape.safeParse(raw);
    return file.success ? [file.data] : [];
  });
}

/** Most members a group holds, the lead counted, and fewest. */
export const spadeGroupMembersMax = 32;
export const spadeGroupMembersMin = 2;
export const spadeGroupNameMax = 60;

/** A template a new bot may start from, shipped with Spade. */
export interface SpadeTemplate {
  id: string;
  name: string;
  blurb: string;
  task: string;
  /** Its face; a template without a readable one gets the face its id seeds. */
  face: BotFace;
  /** Its routines, each with its schedule in Spade's own words (`Weekdays at 8:00`). */
  routines: SpadeTemplateRoutine[];
}

export interface SpadeTemplateRoutine {
  name: string;
  words: string;
}

const templateRoutine = z
  .object({
    name: z.string().catch(""),
    words: z.string().catch(""),
    schedule: z.string().catch(""),
  })
  .transform((routine) => ({ name: routine.name, words: routine.words || routine.schedule }));

const templateShape = z.object({
  id: z.string().min(1),
  name: z.string().catch(""),
  blurb: z.string().catch(""),
  task: z.string().catch(""),
  face: z.unknown().optional(),
  routines: z.array(z.unknown()).catch([]),
});

/** A template's routines in one quiet line: `Morning inbox, weekdays at 8:00`. Pure. */
export function spadeTemplateRoutinesLine(routines: readonly SpadeTemplateRoutine[]): string {
  return routines
    .map((routine) => {
      const when = routine.words ? routine.words[0]?.toLowerCase() + routine.words.slice(1) : "";
      return [routine.name, when].filter(Boolean).join(", ");
    })
    .filter(Boolean)
    .join(" · ");
}

/** `GET /v1/templates`; undefined when the body has no list. */
export function parseSpadeTemplates(body: string): SpadeTemplate[] | undefined {
  const list = spadeRecord(spadeJson(body))?.templates;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const template = templateShape.safeParse(raw);
    if (!template.success) return [];
    const { face, routines, ...rest } = template.data;
    return [
      {
        ...rest,
        face: parseStoredBotFace(face)?.face ?? faceForId(rest.id),
        routines: routines.flatMap((entry) => {
          const routine = templateRoutine.safeParse(entry);
          return routine.success ? [routine.data] : [];
        }),
      },
    ];
  });
}

const leftOutShape = z.array(z.string()).catch([]);

/** `POST /v1/agents/import`: the new bot, and one line for each part this machine left out. */
export function parseSpadeImport(
  body: string,
): { agent: SpadeAgent; leftOut: string[] } | undefined {
  const record = spadeRecord(spadeJson(body));
  const agent = parseSpadeAgentValue(record?.agent);
  if (!agent) return undefined;
  const leftOut = leftOutShape.parse(record?.left_out ?? []);
  return { agent, leftOut };
}

/** The file name an exported bot is saved under: `<name>.spade-bot.json`, safe on every OS. */
export function spadeBotFileName(name: string): string {
  const safe = name
    .replaceAll(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/g, " ")
    .replace(/^\.+/, "");
  return `${safe || "bot"}.spade-bot.json`;
}
