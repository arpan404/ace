import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachines } from "@/lib/machines.ts";
import { markSeen, pinAgent } from "./spade-api.ts";
import { useOpenProfile } from "./spade-bot-screen.tsx";
import { SpadeMachineScope, spadeMachineKey, useSpadeClient } from "./spade-machine.tsx";
import { deleteGroup, pinGroup } from "./spade-teams-api.ts";
import type { SpadeListEntry } from "./spade-list-rows.ts";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import { groupsKey, type RosterGroup } from "./use-spade-groups.ts";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

/*
 * A list row's or a strip face's right-click menu (long-press on touch): Pin or Unpin, Mark as
 * read, Open profile, Duplicate, Export, Delete, only those that apply. A group has Pin or Unpin,
 * Mark as read, Open and Delete. Every call goes to the machine the conversation lives on.
 */

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

export function SpadeRowMenu(props: { entry: SpadeListEntry; children: ReactNode }) {
  const { entry } = props;
  const machines = useMachines();
  const unavailable = entry.kind === "bot" ? entry.bot : entry.group;
  const machine = machines.find((each) => spadeMachineKey(each) === unavailable.machine.key);
  // Offline or not answering: nothing to ask of it, so the row keeps to its plain look.
  if (!machine || unavailable.away || unavailable.unavailable) return props.children;
  return (
    <SpadeMachineScope machine={machine} unavailable={props.children}>
      {entry.kind === "bot" ? (
        <BotMenu bot={entry.bot}>{props.children}</BotMenu>
      ) : (
        <GroupMenu group={entry.group}>{props.children}</GroupMenu>
      )}
    </SpadeMachineScope>
  );
}

/** Reads the roster again once a change is made, whichever of the two lists it touches. */
function useRefresh() {
  const queries = useQueryClient();
  return () =>
    Promise.all([
      queries.invalidateQueries({ queryKey: agentsKey }),
      queries.invalidateQueries({ queryKey: groupsKey }),
    ]);
}

function Menu(props: { label: string; items: ReactNode; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{props.children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={props.label}>{props.items}</ContextMenuContent>
    </ContextMenu>
  );
}

function BotMenu(props: { bot: RosterBot; children: ReactNode }) {
  const { bot } = props;
  const client = useSpadeClient();
  const refresh = useRefresh();
  const toast = useToast();
  const navigate = useNavigate();
  const openId = useParams({ strict: false, select: (params) => params.agentId });
  const openProfile = useOpenProfile(bot);
  const duplicate = useDuplicateBot();
  const exportBot = useExportBot();
  const remove = useDeleteBot();
  const [confirming, setConfirming] = useState<Confirming>();
  const pinned = bot.pinnedAt !== undefined;
  const run = async (what: () => Promise<unknown>, failed: string): Promise<boolean> => {
    try {
      await what();
      await refresh();
      return true;
    } catch (error) {
      toast.error({ title: failed, description: fault(error) });
      return false;
    }
  };
  return (
    <>
      <Menu
        label={`Actions for ${bot.name}`}
        items={
          <>
            <MenuItem
              onClick={() =>
                void run(
                  () => pinAgent(client, bot.id, !pinned),
                  `Couldn't ${pinned ? "unpin" : "pin"} ${bot.name}`,
                )
              }
            >
              {pinned ? "Unpin" : "Pin"}
            </MenuItem>
            {bot.unseen && (
              <MenuItem
                onClick={() =>
                  void run(
                    () => markSeen(client, bot.conversation, undefined),
                    `Couldn't mark ${bot.name} as read`,
                  )
                }
              >
                Mark as read
              </MenuItem>
            )}
            <MenuItem onClick={() => openProfile()}>Open profile</MenuItem>
            <MenuItem
              onClick={() =>
                void duplicate(bot).then((copy) => {
                  if (copy)
                    void navigate({
                      to: "/spade/$agentId",
                      params: { agentId: copy.id },
                      search: bot.machine.primary ? {} : { on: bot.machine.key },
                    });
                })
              }
            >
              Duplicate
            </MenuItem>
            <MenuItem onClick={() => void exportBot(bot)}>Export</MenuItem>
            {bot.kind !== "main" && (
              <MenuItem
                danger
                onClick={() =>
                  setConfirming({
                    title: `Delete ${bot.name}?`,
                    body: `This deletes ${bot.name} and its whole conversation.`,
                    confirm: "Delete bot",
                    run: () =>
                      void remove(bot).then((done) => {
                        if (done && openId === bot.id)
                          void navigate({ to: "/spade", replace: true });
                      }),
                  })
                }
              >
                Delete
              </MenuItem>
            )}
          </>
        }
      >
        {props.children}
      </Menu>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}

function GroupMenu(props: { group: RosterGroup; children: ReactNode }) {
  const { group } = props;
  const client = useSpadeClient();
  const refresh = useRefresh();
  const toast = useToast();
  const navigate = useNavigate();
  const openId = useParams({ strict: false, select: (params) => params.groupId });
  const [confirming, setConfirming] = useState<Confirming>();
  const pinned = group.pinnedAt !== undefined;
  const run = async (what: () => Promise<unknown>, failed: string): Promise<boolean> => {
    try {
      await what();
      await refresh();
      return true;
    } catch (error) {
      toast.error({ title: failed, description: fault(error) });
      return false;
    }
  };
  return (
    <>
      <Menu
        label={`Actions for ${group.name}`}
        items={
          <>
            <MenuItem
              onClick={() =>
                void run(
                  () => pinGroup(client, group.id, !pinned),
                  `Couldn't ${pinned ? "unpin" : "pin"} ${group.name}`,
                )
              }
            >
              {pinned ? "Unpin" : "Pin"}
            </MenuItem>
            {group.unseen && (
              <MenuItem
                onClick={() =>
                  void run(
                    () => markSeen(client, group.conversation, undefined),
                    `Couldn't mark ${group.name} as read`,
                  )
                }
              >
                Mark as read
              </MenuItem>
            )}
            <MenuItem
              onClick={() =>
                void navigate({
                  to: "/spade/groups/$groupId",
                  params: { groupId: group.id },
                  search: group.machine.primary ? {} : { on: group.machine.key },
                })
              }
            >
              Open
            </MenuItem>
            <MenuItem
              danger
              onClick={() =>
                setConfirming({
                  title: `Delete ${group.name}?`,
                  body: `This deletes ${group.name} and its conversation. Its bots stay.`,
                  confirm: "Delete group",
                  run: () =>
                    void run(
                      () => deleteGroup(client, group.id),
                      `Couldn't delete ${group.name}`,
                    ).then((done) => {
                      if (done && openId === group.id)
                        void navigate({ to: "/spade", replace: true });
                    }),
                })
              }
            >
              Delete
            </MenuItem>
          </>
        }
      >
        {props.children}
      </Menu>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}
