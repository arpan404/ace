import {
  spadeGroupMembersMax,
  spadeGroupMembersMin,
  type SpadeAvatar,
} from "@ace/ui-core/spade-chat";
import type { SpadeGroupDraft, SpadeMemberRef } from "./spade-teams-api.ts";

/*
 * The New group and Edit group form's rules, with no I/O: which bots it offers, in what order,
 * which may lead, and the body Spade takes (spade/docs/teams.md).
 */

/** A bot the form offers as a member. */
export interface MemberChoice {
  /** `<host id>/<agent id>`: one bot of one machine. */
  key: string;
  agent: string;
  /** The host id of the bot's machine. */
  host: string;
  name: string;
  avatar: SpadeAvatar;
  machineName: string;
  /** Spade itself, which leads when no other lead is picked. */
  main: boolean;
  away: boolean;
}

export const choiceKey = (host: string, agent: string) => `${host}/${agent}`;

/** Bots of the group's machine first, then the rest, each in the order the roster has them. */
export function orderChoices(choices: readonly MemberChoice[], groupHost: string): MemberChoice[] {
  return choices.toSorted((a, b) => Number(b.host === groupHost) - Number(a.host === groupHost));
}

/** Spade leads unless the person picks another member of the group's machine. */
export const spadeLeads = "";

/** Who may lead: members of the group's machine (Spade's choice stands for Spade). */
export function leadChoices(
  picked: readonly MemberChoice[],
  groupHost: string,
): { value: string; label: string }[] {
  return [
    { value: spadeLeads, label: "Spade" },
    ...picked
      .filter((choice) => choice.host === groupHost && !choice.main)
      .map((choice) => ({ value: choice.agent, label: choice.name })),
  ];
}

/** How many members the group would have: Spade joins when it leads without being picked. */
export function memberCount(picked: readonly MemberChoice[], lead: string): number {
  return picked.length + (lead === spadeLeads && !picked.some((choice) => choice.main) ? 1 : 0);
}

/** Why the form can't be sent yet, in words; undefined when it can. */
export function groupProblem(name: string, picked: readonly MemberChoice[], lead: string) {
  const count = memberCount(picked, lead);
  if (!name.trim()) return "Name the group.";
  if (count < spadeGroupMembersMin) return "Pick at least one more bot.";
  if (count > spadeGroupMembersMax) return `A group holds up to ${spadeGroupMembersMax} bots.`;
  return undefined;
}

/** Members as Spade takes them: the machine named only for a bot of another machine. */
export function memberRefs(picked: readonly MemberChoice[], groupHost: string): SpadeMemberRef[] {
  return picked.map((choice) =>
    choice.host === groupHost
      ? { agent: choice.agent }
      : { agent: choice.agent, machine: choice.host },
  );
}

/**
 * The body for `POST /v1/groups`. A picked lead is sent; Spade leading needs no `lead`, unless
 * Spade was picked as a member of the group's machine, when it is named.
 */
export function newGroupBody(
  name: string,
  picked: readonly MemberChoice[],
  lead: string,
  groupHost: string,
): SpadeGroupDraft {
  const spade = picked.find((choice) => choice.main && choice.host === groupHost);
  const leader = lead === spadeLeads ? spade?.agent : lead;
  return {
    name: name.trim(),
    members: memberRefs(picked, groupHost),
    ...(leader === undefined ? {} : { lead: leader }),
  };
}

/** What changed for `PATCH /v1/groups/{id}`: only the fields that moved. */
export function groupChange(
  before: { name: string; members: readonly SpadeMemberRef[]; lead: string },
  after: SpadeGroupDraft,
): Partial<SpadeGroupDraft> {
  const refKey = (ref: SpadeMemberRef) => `${ref.machine ?? ""}/${ref.agent}`;
  const sameMembers =
    before.members.length === after.members.length &&
    before.members.every((ref, index) => {
      const other = after.members[index];
      return other !== undefined && refKey(ref) === refKey(other);
    });
  return {
    ...(after.name !== before.name ? { name: after.name } : {}),
    ...(sameMembers ? {} : { members: after.members }),
    ...(after.lead !== undefined && after.lead !== before.lead ? { lead: after.lead } : {}),
  };
}
