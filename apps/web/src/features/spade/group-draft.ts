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

/** Spade on the group's machine, when it runs there: only then can it lead or join there. */
export function hostSpade(
  choices: readonly MemberChoice[],
  groupHost: string,
): MemberChoice | undefined {
  return choices.find((choice) => choice.main && choice.host === groupHost);
}

/**
 * Who may lead: Spade when it runs on the group's machine, then the picked members of that
 * machine.
 */
export function leadChoices(
  picked: readonly MemberChoice[],
  groupHost: string,
  spade: MemberChoice | undefined,
): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = [];
  if (spade) choices.push({ value: spadeLeads, label: spade.name });
  for (const choice of picked)
    if (choice.host === groupHost && !choice.main)
      choices.push({ value: choice.agent, label: choice.name });
  return choices;
}

/** The lead that stands: the one asked for while it may lead, else the first that may. */
export function standingLead(leads: readonly { value: string }[], lead: string): string {
  return leads.some((choice) => choice.value === lead) ? lead : (leads[0]?.value ?? spadeLeads);
}

/** Members as the form sends them: Spade joins, first, when it leads without being picked. */
function withLead(
  picked: readonly MemberChoice[],
  lead: string,
  spade: MemberChoice | undefined,
): readonly MemberChoice[] {
  if (lead !== spadeLeads || !spade || picked.some((choice) => choice.key === spade.key))
    return picked;
  return [spade, ...picked];
}

/** How many members the group would have, Spade counted when it leads without being picked. */
export function memberCount(
  picked: readonly MemberChoice[],
  lead: string,
  spade: MemberChoice | undefined,
): number {
  return withLead(picked, lead, spade).length;
}

/** Why the form can't be sent yet, in words; undefined when it can. */
export function groupProblem(
  name: string,
  picked: readonly MemberChoice[],
  lead: string,
  spade: MemberChoice | undefined,
) {
  const count = memberCount(picked, lead, spade);
  if (!name.trim()) return "Name the group.";
  if (lead === spadeLeads && !spade) return "Pick a bot of the group's machine to lead.";
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
 * The body for `POST /v1/groups`, and what an edit compares against. The lead is always named:
 * Spade by its id on the group's machine, joining the members when it wasn't picked.
 */
export function newGroupBody(
  name: string,
  picked: readonly MemberChoice[],
  lead: string,
  groupHost: string,
  spade: MemberChoice | undefined,
): SpadeGroupDraft {
  const leader = lead === spadeLeads ? spade?.agent : lead;
  const draft: SpadeGroupDraft = {
    name: name.trim(),
    members: memberRefs(withLead(picked, lead, spade), groupHost),
  };
  if (leader !== undefined) draft.lead = leader;
  return draft;
}

const refKey = (ref: SpadeMemberRef) => `${ref.machine ?? ""}/${ref.agent}`;

/** What changed for `PATCH /v1/groups/{id}`: only the fields that moved. */
export function groupChange(
  before: { name: string; members: readonly SpadeMemberRef[]; lead: string },
  after: SpadeGroupDraft,
): Partial<SpadeGroupDraft> {
  const sameMembers =
    before.members.length === after.members.length &&
    before.members.every((ref, index) => {
      const other = after.members[index];
      return other !== undefined && refKey(ref) === refKey(other);
    });
  const change: Partial<SpadeGroupDraft> = {};
  if (after.name !== before.name) change.name = after.name;
  if (!sameMembers) change.members = after.members;
  if (after.lead !== undefined && after.lead !== before.lead) change.lead = after.lead;
  return change;
}
