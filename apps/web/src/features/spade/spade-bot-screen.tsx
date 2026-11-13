import { botFaceStateOf } from "@ace/ui-core/bot-face";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Screen } from "@/features/shell/index.ts";
import { EditBotDialog } from "./spade-bot-dialog.tsx";
import { MemoryDialog, type MemoryOpen } from "./spade-memory-dialog.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** A bot's page other than its conversation and files. */
export type BotView = "routines" | "activity";

/** Where a bot's screen goes: its conversation, a folder (and file) of its files, or a view. */
export function useOpenBot(bot: RosterBot) {
  const navigate = useNavigate();
  return (to: { files?: string; file?: string; view?: BotView } = {}) =>
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: bot.id },
      search: {
        ...(bot.machine.primary ? {} : { on: bot.machine.key }),
        ...(to.files === undefined ? {} : { files: to.files || "." }),
        ...(to.file === undefined ? {} : { file: to.file }),
        ...(to.view === undefined ? {} : { view: to.view }),
      },
    });
}

const viewTitles: Record<BotView, string> = { routines: "Routines", activity: "Activity" };

/**
 * The screen's frame for one bot: its face and name in the top bar; in ⋯ the bot's other pages
 * (Conversation, Files, Routines, Activity, leaving out the one shown), Memory, Edit, Duplicate,
 * Export and Delete.
 * `children` may open the Memory dialog itself (a "Remembered" line).
 */
export function BotScreen(props: {
  bot: RosterBot;
  files?: boolean;
  view?: BotView | undefined;
  children: ReactNode | ((openMemory: (open: MemoryOpen) => void) => ReactNode);
}) {
  const { bot } = props;
  const [editing, setEditing] = useState(false);
  const [memory, setMemory] = useState<MemoryOpen>();
  const [confirming, setConfirming] = useState<Confirming>();
  const remove = useDeleteBot();
  const duplicate = useDuplicateBot();
  const exportBot = useExportBot();
  const navigate = useNavigate();
  const openBot = useOpenBot(bot);
  const main = bot.kind === "main";
  const headState = bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot);
  const conversation = !props.files && props.view === undefined;
  const page = props.files ? "Files" : props.view ? viewTitles[props.view] : undefined;
  return (
    <Screen
      title={page ? `${bot.name} · ${page}` : bot.name}
      mark={<SpadeFace avatar={bot.avatar} size={20} state={headState} />}
      menu={
        bot.away || bot.unavailable ? undefined : (
          <>
            {!conversation && <MenuItem onClick={() => openBot()}>Conversation</MenuItem>}
            {!props.files && <MenuItem onClick={() => openBot({ files: "" })}>Files</MenuItem>}
            {(["routines", "activity"] as const)
              .filter((view) => view !== props.view)
              .map((view) => (
                <MenuItem key={view} onClick={() => openBot({ view })}>
                  {viewTitles[view]}
                </MenuItem>
              ))}
            <MenuItem onClick={() => setMemory({ shared: false })}>Memory</MenuItem>
            <MenuItem onClick={() => setEditing(true)}>{main ? "Edit Spade" : "Edit bot"}</MenuItem>
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
            {!main && (
              <MenuItem
                danger
                onClick={() =>
                  setConfirming({
                    title: `Delete ${bot.name}?`,
                    body: `This deletes ${bot.name} and its whole conversation.`,
                    confirm: "Delete bot",
                    run: () =>
                      void remove(bot).then((done) => {
                        if (done) void navigate({ to: "/spade", replace: true });
                      }),
                  })
                }
              >
                Delete bot
              </MenuItem>
            )}
          </>
        )
      }
    >
      {typeof props.children === "function" ? props.children(setMemory) : props.children}
      {editing && <EditBotDialog bot={bot} onClose={() => setEditing(false)} />}
      {memory && <MemoryDialog bot={bot} open={memory} onClose={() => setMemory(undefined)} />}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </Screen>
  );
}
