import { botFaceStateOf } from "@ace/ui-core/bot-face";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Screen } from "@/features/shell/index.ts";
import { readPanel, type ComputerView, type ProfileTab } from "./computer/panel-place.ts";
import { SpadeFace } from "./spade-face.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** Where a bot's screen goes: its conversation, with its profile open on a tab or not. */
export interface BotPlace {
  /** The profile open on this tab. */
  profile?: ProfileTab;
  /** With the profile on Computer: what it shows. */
  computer?: ComputerView;
  /** With Computer on Files: the folder shown and a file open in it. */
  files?: string;
  file?: string;
}

/** The search a bot's route takes for `to`. */
export function botSearch(bot: RosterBot, to: BotPlace = {}) {
  return {
    ...(bot.machine.primary ? {} : { on: bot.machine.key }),
    ...(to.profile === undefined ? {} : { profile: to.profile }),
    ...(to.computer === undefined ? {} : { computer: to.computer }),
    ...(to.files === undefined ? {} : { files: to.files || "." }),
    ...(to.file === undefined ? {} : { file: to.file }),
  };
}

/** Opens a place of the bot's screen. */
export function useOpenBot(bot: RosterBot) {
  const navigate = useNavigate();
  return (to: BotPlace = {}, replace = false) =>
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: bot.id },
      search: botSearch(bot, to),
      replace,
    });
}

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/**
 * Opens the bot's profile beside its conversation: the one way the pill reaches the bot's
 * details and what acts on it. With no tab named, on the tab the person left it on.
 */
export function useOpenProfile(bot: RosterBot) {
  const open = useOpenBot(bot);
  return (tab?: ProfileTab) =>
    open({ profile: tab ?? readPanel(storage(), `${bot.machine.key}/${bot.id}`).tab });
}

/**
 * A bot's conversation's frame: the bar carries no title, since the pill over the transcript
 * names the bot; only the conversation's own actions sit at its end.
 */
export function ConversationScreen(props: { actions?: ReactNode; children: ReactNode }) {
  return (
    <Screen page="spade" title="" actions={props.actions}>
      {props.children}
    </Screen>
  );
}

/**
 * The frame for a bot whose conversation can't show (its machine offline, its Spade off): the
 * bot's face, still, and its name over its machine.
 */
export function BotScreen(props: { bot: RosterBot; children: ReactNode }) {
  const { bot } = props;
  const headState = bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot);
  return (
    <Screen
      page="spade"
      title={
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-ui leading-4 font-medium">{bot.name}</span>
          <span className="truncate text-xs leading-4 font-normal text-subtle-foreground">
            {bot.machine.name}
          </span>
        </span>
      }
      mark={<SpadeFace avatar={bot.avatar} size={20} state={headState} />}
    >
      {props.children}
    </Screen>
  );
}
