import { faceForId, type BotFace } from "@ace/ui-core/bot-face";
import {
  spadeGroupWaiting,
  type SpadeAgent,
  type SpadeAvatar,
  type SpadeGroup,
  type SpadeGroupBot,
  type SpadeGroupView,
} from "@ace/ui-core/spade-chat";

/*
 * A group (ADR 0132) as the iPhone draws it, from the shared group fold: each member's face, its
 * messages with its name above a run and its face beside the run's last, a handoff as one line,
 * and the line under the last message naming who answers or waits. Pure: no I/O.
 */

/** A face the phone draws: Spade's mark when `main`, else its character face; away dims it. */
export interface SpadeFaceRow {
  main: boolean;
  /** Accessibility fallback when a face stands on its own. */
  initial: string;
  away: boolean;
  /** Character face geometry traits from `@ace/ui-core/bot-face`; null for Spade itself. */
  character: BotFace | null;
}

export const initialOf = (name: string) => (name.trim()[0] ?? "?").toLocaleUpperCase();

function characterOf(avatar: SpadeAvatar, id: string): BotFace {
  return avatar.kind === "character" ? avatar.face : faceForId(id);
}

/** A bot's own face. */
export const botFace = (
  agent: Pick<SpadeAgent, "id" | "kind" | "name" | "avatar">,
): SpadeFaceRow => {
  const main = agent.kind === "main" || agent.avatar.kind === "spade";
  return {
    main,
    initial: initialOf(agent.name),
    away: false,
    character: main ? null : characterOf(agent.avatar, agent.id),
  };
};

type Member = SpadeGroup["members"][number];

/** Normalizes this machine (`null` or matching `hostId`) to `null`; remote machines keep their host id. */
const machineKey = (machine: string | null | undefined, hostId?: string): string | null =>
  !machine || (hostId !== undefined && machine === hostId) ? null : machine;

/** Current roster bot on this machine (`machine` null or `hostId`); remote bots never match local ids. */
const rosterAgent = (
  agents: readonly SpadeAgent[],
  id: string,
  machine: string | null | undefined,
  hostId?: string,
): SpadeAgent | undefined =>
  machineKey(machine, hostId) === null ? agents.find((agent) => agent.id === id) : undefined;

/**
 * A member's face as the group names it: prefers the current roster avatar on this machine
 * (matched by machine and bot id), falling back to the avatar saved with the membership.
 */
function memberFace(member: Member, agents: readonly SpadeAgent[], hostId?: string): SpadeFaceRow {
  const roster = rosterAgent(agents, member.agent, member.machine, hostId);
  const avatar = roster?.avatar ?? member.avatar;
  const spade = avatar.kind === "spade" || roster?.kind === "main";
  return {
    main: spade,
    initial: initialOf(roster?.name || member.name),
    away: member.away,
    character: spade ? null : characterOf(avatar, member.agent),
  };
}

/** The faces a group's row stacks: its first three members, the lead first. */
export function groupFaces(
  group: SpadeGroup,
  agents: readonly SpadeAgent[],
  hostId?: string,
): SpadeFaceRow[] {
  const sameAsLead = (member: Member) =>
    member.agent === group.lead.agent &&
    machineKey(member.machine, hostId) === machineKey(group.lead.machine, hostId);
  const members = [group.lead, ...group.members.filter((member) => !sameAsLead(member))];
  return members.slice(0, 3).map((member) => memberFace(member, agents, hostId));
}

const sameBot = (member: Member, bot: SpadeGroupBot, hostId?: string) =>
  member.agent === bot.id && machineKey(member.machine, hostId) === machineKey(bot.machine, hostId);

/** A bot the group names, preferring the current roster avatar on this machine over its saved membership. */
function faceOf(
  group: SpadeGroup | undefined,
  bot: SpadeGroupBot,
  agents: readonly SpadeAgent[],
  hostId?: string,
): SpadeFaceRow {
  const member =
    group?.members.find((each) => sameBot(each, bot, hostId)) ??
    (group && sameBot(group.lead, bot, hostId) ? group.lead : undefined);
  if (member) return memberFace(member, agents, hostId);
  const roster = rosterAgent(agents, bot.id, bot.machine, hostId);
  if (roster) return botFace(roster);
  return {
    main: false,
    initial: initialOf(bot.name),
    away: false,
    character: faceForId(bot.id),
  };
}

export type SpadeGroupBubbleRow =
  | { kind: "person"; text: string; sending: boolean; attached: null }
  | {
      kind: "member";
      name: string;
      text: string;
      face: SpadeFaceRow;
      /** First of the member's run: its name shows above. */
      first: boolean;
      /** Last of the run: its face shows beside. */
      last: boolean;
    }
  | { kind: "note"; text: string };

/** A group's messages with their keys, in order. */
export function spadeGroupRows(
  view: SpadeGroupView,
  group: SpadeGroup | undefined,
  agents: readonly SpadeAgent[],
  hostId?: string,
): { key: string; row: SpadeGroupBubbleRow }[] {
  return view.rows.map((row) => {
    switch (row.kind) {
      case "person":
        return {
          key: row.key,
          row: { kind: "person", text: row.text, sending: row.sending, attached: null },
        };
      case "member":
        return {
          key: row.key,
          row: {
            kind: "member",
            name: row.bot.name || "Bot",
            text: row.text,
            face: faceOf(group, row.bot, agents, hostId),
            first: row.first,
            last: row.last,
          },
        };
      case "line":
        return { key: row.key, row: { kind: "note", text: row.text } };
    }
  });
}

/**
 * The group around its messages. While it works, one line names who answers, with that
 * member's face; a member waiting on the person says so and names its own chat (`waiting`),
 * where the approval or question is, when that bot is on this machine.
 */
export function spadeGroupHead(
  id: string,
  view: SpadeGroupView,
  problem: string | undefined,
  group: SpadeGroup | undefined,
  agents: readonly SpadeAgent[],
  hostId?: string,
) {
  const bots: SpadeGroupBot[] = (group?.members ?? []).map((member) => ({
    id: member.agent,
    name: member.name,
    machine: member.machine,
  }));
  const waiter = spadeGroupWaiting(view, bots);
  const shown = waiter ?? view.working;
  const named = shown?.name || "A member";
  const label =
    view.status ??
    (shown ? (waiter ? `${named} is waiting for you` : `${named} is answering`) : "Working");
  const own = waiter ? rosterAgent(agents, waiter.id, waiter.machine, hostId) : undefined;
  return {
    type: "spade.conversation",
    id,
    group: group?.id ?? null,
    loaded: view.loaded,
    problem: problem ?? null,
    answering: view.busy,
    later: null,
    working: view.busy
      ? {
          label,
          moving: view.state !== "waiting",
          face: shown ? faceOf(group, shown, agents, hostId) : null,
        }
      : null,
    waiting: waiter && own ? { name: own.name || named, conversation: own.conversation } : null,
  };
}
