import { botFaceStateOf } from "@ace/ui-core/bot-face";
import type { SpadeSurfaceKind } from "@ace/ui-core/spade-chat";
import { CaretDownIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Icon } from "@/components/icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Screen } from "@/features/shell/index.ts";
import { EditBotDialog } from "./spade-bot-dialog.tsx";
import { MemoryDialog, type MemoryOpen } from "./spade-memory-dialog.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** A bot's page other than its conversation: its own page, or one of its sections alone. */
export type BotView = "bot" | "routines" | "activity";

/** Where a bot's screen goes. */
export interface BotPlace {
  /** The computer expanded on this surface. */
  computer?: SpadeSurfaceKind;
  /** With the computer on Files: the folder shown and a file open in it. */
  files?: string;
  file?: string;
  view?: BotView;
}

/** The search a bot's route takes for `to`. */
export function botSearch(bot: RosterBot, to: BotPlace = {}) {
  return {
    ...(bot.machine.primary ? {} : { on: bot.machine.key }),
    ...(to.computer === undefined ? {} : { computer: to.computer }),
    ...(to.files === undefined ? {} : { files: to.files || "." }),
    ...(to.file === undefined ? {} : { file: to.file }),
    ...(to.view === undefined ? {} : { view: to.view }),
  };
}

/** Opens a place of the bot's screen. */
export function useOpenBot(bot: RosterBot) {
  const navigate = useNavigate();
  return (to: BotPlace = {}) =>
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: bot.id },
      search: botSearch(bot, to),
    });
}

/**
 * The screen's frame for one bot. Its top bar: the bot's face (moving while it works), its name
 * and machine, and a caret; they open the bot's own page. ⋯ holds what acts on the bot: Edit,
 * Duplicate, Export and Delete. `children` may open the Memory dialog itself (a "Remembered"
 * line).
 */
export function BotScreen(props: {
  bot: RosterBot;
  /** The bot's own page shows: its name stays put rather than leading to itself. */
  page?: boolean;
  /** Right-hand actions in the top bar (Chat, beside an expanded computer). */
  actions?: ReactNode;
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
  const main = bot.kind === "main";
  const headState = bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot);
  const name = (
    <>
      <span className="truncate">{bot.name}</span>
      <span className="truncate font-normal text-muted-foreground">{bot.machine.name}</span>
    </>
  );
  return (
    <Screen
      title={
        props.page ? (
          <span className="flex min-w-0 items-baseline gap-2">{name}</span>
        ) : (
          <Link
            to="/spade/$agentId"
            params={{ agentId: bot.id }}
            search={botSearch(bot, { view: "bot" })}
            aria-label={`${bot.name} on ${bot.machine.name}: open its page`}
            className="-mx-1 flex min-w-0 items-baseline gap-2 rounded-md px-1 focus-ring hover:bg-hover"
          >
            {name}
            <Icon
              icon={CaretDownIcon}
              size={12}
              className="shrink-0 self-center text-muted-foreground"
            />
          </Link>
        )
      }
      mark={<SpadeFace avatar={bot.avatar} size={20} state={headState} />}
      actions={props.actions}
      menu={
        bot.away || bot.unavailable ? undefined : (
          <>
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
              <MenuItem danger onClick={() => setConfirming(deleting(bot, remove, navigate))}>
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

/** Delete, asked first: the bot and its whole conversation go. */
export function deleting(
  bot: RosterBot,
  remove: ReturnType<typeof useDeleteBot>,
  navigate: ReturnType<typeof useNavigate>,
): Confirming {
  return {
    title: `Delete ${bot.name}?`,
    body: `This deletes ${bot.name} and its whole conversation.`,
    confirm: "Delete bot",
    run: () =>
      void remove(bot).then((done) => {
        if (done) void navigate({ to: "/spade", replace: true });
      }),
  };
}
