import type { SpadeGroupBot } from "@ace/ui-core/spade-chat";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useMachines } from "@/lib/machines.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeGroupChat, unknownFace, type GroupFace } from "./spade-group-chat.tsx";
import { GroupFaces } from "./spade-group-faces.tsx";
import { GroupPill } from "./spade-group-pill.tsx";
import { GroupProfile } from "./spade-group-profile.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { SpadeMachineScope, spadeMachineKey } from "./spade-machine.tsx";
import {
  ConversationSkeleton,
  message,
  Problem,
  Scroller,
  useSpadeLine,
} from "./spade-screen-parts.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useGroupConversation } from "./use-group-conversation.ts";
import {
  memberMachineKey,
  shownMembers,
  useSpadeGroups,
  type RosterGroup,
  type ShownMember,
} from "./use-spade-groups.ts";
import { useSpadeRoster, type RosterBot } from "./use-spade-roster.ts";
import { panelReveal } from "@/components/ui/rules.ts";

/** A window too narrow for the profile beside a readable chat: the profile covers the chat. */
const coverQuery = "(max-width: 59.99rem)";

/**
 * `/spade/groups/<group id>` (with `on` when the group lives on another machine): its
 * conversation; with `profile` its profile open beside it.
 */
export function SpadeGroupScreen(props: {
  groupId: string;
  machine: string | undefined;
  profile?: boolean | undefined;
}) {
  const line = useSpadeLine();
  const roster = useSpadeRoster(line.ready);
  const { groups, loading } = useSpadeGroups(roster);
  const machines = useMachines();
  const key = props.machine ?? "primary";
  const machine = machines.find((candidate) => spadeMachineKey(candidate) === key);
  const group = groups.find(
    (candidate) => candidate.id === props.groupId && candidate.machine.key === key,
  );
  if (!group || !machine)
    return (
      <Screen page="spade" title="Spade" namedByPanel>
        <div className={`${readingColumn} pt-6`}>
          {!line.ready ? (
            <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
          ) : roster.loading || loading ? (
            <ConversationSkeleton />
          ) : (
            <p className="text-ui text-muted-foreground">
              This group isn't here any more.{" "}
              <Link to="/spade" className="text-foreground underline underline-offset-3">
                Open Spade
              </Link>
            </p>
          )}
        </div>
      </Screen>
    );
  if (group.away || group.unavailable)
    return (
      <GroupScreen group={group} bots={roster.bots}>
        <div className={`${readingColumn} pt-6 text-ui text-muted-foreground`}>
          {group.away
            ? `${machine.name} is offline. ${group.name} is back when it is.`
            : `Spade isn't running on ${machine.name}. ${group.name} is back when it is.`}
        </div>
      </GroupScreen>
    );
  return (
    <SpadeMachineScope
      machine={machine}
      unavailable={
        <GroupScreen group={group} bots={roster.bots}>
          <div className={`${readingColumn} pt-6 text-ui text-muted-foreground`}>
            {`${machine.name} is offline. ${group.name} is back when it is.`}
          </div>
        </GroupScreen>
      }
    >
      <Conversation
        key={`${group.machine.key}/${group.id}`}
        group={group}
        bots={roster.bots}
        profile={props.profile === true}
      />
    </SpadeMachineScope>
  );
}

/** The frame for a group that can't answer now: its faces and name in the top bar. */
function GroupScreen(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  children: ReactNode;
}) {
  const { group } = props;
  const machines = useMachines();
  const members = shownMembers(machines, group, props.bots);
  return (
    <Screen
      page="spade"
      title={group.name}
      subtitle={members.map((member) => member.name).join(", ")}
      mark={<GroupFaces members={members} size={20} />}
    >
      {props.children}
    </Screen>
  );
}

/**
 * A group's conversation under its pill (the members' faces and the group's name), which opens
 * its profile in the side panel; the bar carries no title. In a narrow window the profile covers
 * the chat, with Chat to go back.
 */
function Conversation(props: { group: RosterGroup; bots: readonly RosterBot[]; profile: boolean }) {
  const { group, bots } = props;
  const conversation = useGroupConversation(group);
  const { view, problem } = conversation;
  const line = useSpadeLine();
  const toast = useToast();
  const machines = useMachines();
  const navigate = useNavigate();
  const covering = useMediaQuery(coverQuery, false);
  const members = shownMembers(machines, group, bots);
  const [stopping, setStopping] = useState(false);
  if (stopping && !view.busy) setStopping(false);
  const stop = () => {
    setStopping(true);
    conversation.stop().catch((error: unknown) => {
      setStopping(false);
      toast.error({ title: `Couldn't stop ${group.name}`, description: message(error) });
    });
  };
  const showProfile = (open: boolean) =>
    void navigate({
      to: "/spade/groups/$groupId",
      params: { groupId: group.id },
      search: {
        ...(group.machine.primary ? {} : { on: group.machine.key }),
        ...(open ? { profile: true } : {}),
      },
    });
  const faceOf = (bot: SpadeGroupBot): GroupFace => {
    const machineKey = memberMachineKey(machines, group, bot.machine);
    const member = members.find(
      (candidate) => candidate.agent === bot.id && candidate.machineKey === machineKey,
    );
    const rosterBot =
      member?.bot ??
      bots.find((candidate) => candidate.id === bot.id && candidate.machine.key === machineKey);
    if (!member && !rosterBot) return unknownFace(bot);
    const open = rosterBot
      ? () =>
          void navigate({
            to: "/spade/$agentId",
            params: { agentId: rosterBot.id },
            search: rosterBot.machine.primary ? {} : { on: rosterBot.machine.key },
          })
      : undefined;
    return {
      name: rosterBot?.name ?? member?.name ?? bot.name,
      avatar: rosterBot?.avatar ?? member?.avatar ?? unknownFace(bot).avatar,
      open,
    };
  };
  const shown = props.profile;
  const chat = (
    <div data-thread-column="" className="relative grid h-full min-h-0 grid-cols-1 grid-rows-1">
      <h1 className="sr-only">{group.name}</h1>
      <GroupPill
        name={group.name}
        members={members}
        open={shown}
        onToggle={() => showProfile(!shown)}
      />
      <Scroller
        top="pill"
        seen={
          view.loaded
            ? {
                conversation: group.conversation,
                unseen: group.unseen,
                seq: group.lastMessage?.seq,
              }
            : undefined
        }
      >
        {problem ? (
          <Problem text={problem} onRetry={conversation.retry} />
        ) : !view.loaded ? (
          line.ready ? (
            <ConversationSkeleton />
          ) : (
            <SpadeStateStrip line={line} className="flex items-center gap-2 text-ui" />
          )
        ) : (
          <SpadeGroupChat
            name={group.name}
            view={view}
            members={group.members.map((member, index) => ({
              id: member.agent,
              name: members[index]?.name ?? member.name,
              machine: member.machine,
            }))}
            faceOf={faceOf}
          />
        )}
        {view.loaded && !problem && view.rows.length === 0 && (
          <GroupStart members={members} onAdd={() => showProfile(true)} />
        )}
      </Scroller>
      <SpadeComposer
        name={group.name}
        draftKey={`spade:${group.machine.key}:group:${group.id}`}
        answering={view.busy}
        blocked={line.ready ? undefined : line.sentence}
        placeholder={`Message ${group.name}`}
        mentionNames={members.map((member) => member.name)}
        onStop={stop}
        stopping={stopping}
        // A group with nothing said yet offers to ask one member.
        chips={
          view.loaded && view.rows.length === 0
            ? members.map((member) => ({
                label: `Ask ${member.name}`,
                text: `@${member.name} `,
                face: <SpadeFace avatar={member.avatar} size={18} />,
              }))
            : undefined
        }
        send={conversation.send}
      />
    </div>
  );
  return (
    <Screen page="spade" title="">
      <div className="relative flex h-full min-h-0">
        <div
          className={cn("min-w-0 flex-1", shown && covering && "invisible")}
          aria-hidden={shown && covering ? true : undefined}
        >
          {chat}
        </div>
        {shown && (
          <aside
            aria-label={`${group.name}'s profile`}
            className={cn(
              "bg-panel",
              panelReveal,
              covering ? "absolute inset-0 z-20" : "relative w-96 shrink-0 border-l border-border",
            )}
          >
            <GroupProfile
              group={group}
              bots={bots}
              covering={covering}
              onClose={() => showProfile(false)}
            />
          </aside>
        )}
      </div>
    </Screen>
  );
}

/** A group with nothing said yet: who is in it, and Add a member, which opens its Members. */
function GroupStart(props: { members: readonly ShownMember[]; onAdd(): void }) {
  const names = props.members.map((member) => member.name);
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex items-center gap-2">
        {props.members.map((member) => (
          <SpadeFace
            key={`${member.machineKey}/${member.agent}`}
            avatar={member.avatar}
            size={48}
          />
        ))}
      </div>
      <p className="text-md text-foreground">
        {`${list} ${names.length > 1 ? "are" : "is"} in this group.`}
      </p>
      <Button size="sm" variant="ghost" onClick={props.onAdd}>
        Add a member
      </Button>
    </div>
  );
}
