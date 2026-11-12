import type { SpadeGroupBot } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeGroupChat, unknownFace, type GroupFace } from "./spade-group-chat.tsx";
import { EditGroupDialog } from "./spade-group-dialog.tsx";
import { GroupFaces } from "./spade-group-faces.tsx";
import { SpadeMachineScope, spadeMachineKey, useSpadeClient } from "./spade-machine.tsx";
import {
  ConversationSkeleton,
  message,
  Problem,
  Scroller,
  useSpadeLine,
} from "./spade-screen-parts.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { deleteGroup } from "./spade-teams-api.ts";
import { useGroupConversation } from "./use-group-conversation.ts";
import {
  groupsKey,
  memberMachineKey,
  shownMembers,
  useSpadeGroups,
  type RosterGroup,
} from "./use-spade-groups.ts";
import { useSpadeRoster, type RosterBot } from "./use-spade-roster.ts";

/** `/spade/groups/<group id>` (with `on` when the group lives on another machine). */
export function SpadeGroupScreen(props: { groupId: string; machine: string | undefined }) {
  const line = useSpadeLine();
  const roster = useSpadeRoster(line.ready);
  const { groups, loading } = useSpadeGroups(roster.hosts);
  const machines = useMachines();
  const key = props.machine ?? "primary";
  const machine = machines.find((candidate) => spadeMachineKey(candidate) === key);
  const group = groups.find(
    (candidate) => candidate.id === props.groupId && candidate.machine.key === key,
  );
  if (!group || !machine)
    return (
      <Screen title="Spade" namedByPanel>
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
      <Conversation key={`${group.machine.key}/${group.id}`} group={group} bots={roster.bots} />
    </SpadeMachineScope>
  );
}

/** The screen's frame for a group: its faces and name in the top bar; Edit and Delete in ⋯. */
function GroupScreen(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  menu?: boolean;
  children: ReactNode;
}) {
  const { group } = props;
  const machines = useMachines();
  return (
    <Screen
      title={group.name}
      mark={<GroupFaces members={shownMembers(machines, group, props.bots)} size={20} />}
      menu={props.menu ? <GroupMenu group={group} bots={props.bots} /> : undefined}
    >
      {props.children}
    </Screen>
  );
}

function GroupMenu(props: { group: RosterGroup; bots: readonly RosterBot[] }) {
  const { group } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>();
  const remove = async () => {
    try {
      await deleteGroup(client, group.id);
      await cache.invalidateQueries({ queryKey: groupsKey });
      void navigate({ to: "/spade", replace: true });
    } catch (error) {
      toast.error({ title: `Couldn't delete ${group.name}`, description: message(error) });
    }
  };
  return (
    <>
      <MenuItem onClick={() => setEditing(true)}>Edit group</MenuItem>
      <MenuItem
        danger
        onClick={() =>
          setConfirming({
            title: `Delete ${group.name}?`,
            body: `This deletes ${group.name} and its conversation. Its bots stay.`,
            confirm: "Delete group",
            run: () => void remove(),
          })
        }
      >
        Delete group
      </MenuItem>
      {editing && (
        <EditGroupDialog
          group={group}
          bots={props.bots}
          client={client}
          onClose={() => setEditing(false)}
        />
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}

function Conversation(props: { group: RosterGroup; bots: readonly RosterBot[] }) {
  const { group, bots } = props;
  const conversation = useGroupConversation(group);
  const { view, problem } = conversation;
  const line = useSpadeLine();
  const toast = useToast();
  const machines = useMachines();
  const navigate = useNavigate();
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
  return (
    <GroupScreen group={group} bots={bots} menu>
      <div data-thread-column="" className="grid h-full min-h-0 grid-cols-1 grid-rows-1">
        <Scroller>
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
              stopping={stopping}
              onStop={stop}
            />
          )}
        </Scroller>
        <SpadeComposer
          name={group.name}
          draftKey={`spade:${group.machine.key}:group:${group.id}`}
          answering={view.busy}
          blocked={line.ready ? undefined : line.sentence}
          placeholder={`Message ${group.name}`}
          mentionNames={members.map((member) => member.name)}
          send={conversation.send}
        />
      </div>
    </GroupScreen>
  );
}
