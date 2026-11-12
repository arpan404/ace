import type { SpadeAvatar, SpadeGroup, SpadeGroupMember } from "@ace/ui-core/spade-chat";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";
import { spadeMachineKey, type SpadeMachine } from "./spade-machine.tsx";
import { readGroups } from "./spade-teams-api.ts";
import type { RosterBot, SpadeHost } from "./use-spade-roster.ts";

export const groupsKey = ["spade", "groups"] as const;

/** A group as the roster shows it: with the machine it lives on (its lead's). */
export interface RosterGroup extends SpadeGroup {
  machine: SpadeMachine;
  /** That machine's host id, which members of other machines are named against. */
  host: string;
}

/** A member with the face and name to show, from the roster when its bot is listed there. */
export interface ShownMember {
  agent: string;
  /** The roster key of its machine; undefined for a machine this window doesn't reach. */
  machineKey: string | undefined;
  name: string;
  avatar: SpadeAvatar;
  away: boolean;
  /** Its bot in the roster, when it is listed. */
  bot: RosterBot | undefined;
}

/**
 * The key of the machine a member's bot runs on, as the roster keys machines: the group's own
 * when the member names none, else the machine with that host id, if this window reaches it.
 */
export function memberMachineKey(
  machines: readonly Pick<Machine, "id" | "primary">[],
  group: Pick<RosterGroup, "machine">,
  machine: string | null,
): string | undefined {
  if (machine === null) return group.machine.key;
  const found = machines.find((candidate) => candidate.id === machine);
  return found ? spadeMachineKey(found) : undefined;
}

/**
 * Each member as it shows: its bot's face and name from the roster when the roster lists it
 * (matched by machine and id), else what the group kept. Away when the group or the roster says.
 */
export function shownMembers(
  machines: readonly Pick<Machine, "id" | "primary">[],
  group: Pick<RosterGroup, "machine" | "members">,
  bots: readonly RosterBot[],
): ShownMember[] {
  return group.members.map((member: SpadeGroupMember) => {
    const machineKey = memberMachineKey(machines, group, member.machine);
    const bot = bots.find(
      (candidate) => candidate.id === member.agent && candidate.machine.key === machineKey,
    );
    return {
      agent: member.agent,
      machineKey,
      name: bot?.name ?? member.name,
      avatar: bot?.avatar ?? member.avatar,
      away: member.away || machineKey === undefined || bot?.away === true,
      bot,
    };
  });
}

/**
 * The groups of every machine whose Spade answers (a group lives on its lead's machine), read
 * like the bots: every few seconds, faster while any group works. A machine's last list stays
 * while a read fails.
 */
export function useSpadeGroups(hosts: readonly SpadeHost[]) {
  const results = useQueries({
    queries: hosts.map((host) => ({
      queryKey: [...groupsKey, host.spade.key],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        host.machine.client
          ? readGroups(host.machine.client, { signal })
          : Promise.reject(new Error("offline")),
      enabled: host.machine.client !== undefined,
      gcTime: Number.POSITIVE_INFINITY,
      retry: 1,
      refetchInterval: (query: { state: { data: SpadeGroup[] | undefined } }) =>
        query.state.data?.some((group) => group.state !== "idle") ? 2_000 : 10_000,
    })),
  });
  const dataKey = results.map((result) => result.dataUpdatedAt).join(",");
  const groups = useMemo(
    () =>
      hosts.flatMap((host, index): RosterGroup[] =>
        (results[index]?.data ?? []).map((group) => ({
          ...group,
          machine: host.spade,
          host: host.machine.id,
        })),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `results` is keyed by dataKey
    [hosts, dataKey],
  );
  /** Some answering machine hasn't said its groups yet. */
  const loading = results.some((result) => result.data === undefined && !result.isError);
  return { groups, loading };
}

/** One entry of the Spade panel: a bot, or a group. */
export type RosterEntry = { kind: "bot"; bot: RosterBot } | { kind: "group"; group: RosterGroup };

/** Spade first, then bots and groups by latest activity, newest first. */
export function rosterEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
): RosterEntry[] {
  const entries: RosterEntry[] = [
    ...bots.map((bot) => ({ kind: "bot" as const, bot })),
    ...groups.map((group) => ({ kind: "group" as const, group })),
  ];
  const main = (entry: RosterEntry) => entry.kind === "bot" && entry.bot.kind === "main";
  const activity = (entry: RosterEntry) =>
    entry.kind === "bot" ? entry.bot.lastActivity : entry.group.lastActivity;
  return entries.toSorted((a, b) => Number(main(b)) - Number(main(a)) || activity(b) - activity(a));
}
