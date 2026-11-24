import { CaretRightIcon, ClockIcon } from "@ace/icons";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingCard } from "@/components/setting-row.tsx";
import { part } from "@/lib/suit-part.ts";
import { ComputerCard } from "./computer/computer-card.tsx";
import type { ProfileComputerPlace } from "./computer/profile-computer.tsx";
import { ProfileRoutineRows } from "./spade-profile-routine-rows.tsx";
import { SuggestedApps } from "./spade-suggested-apps.tsx";
import { ProfileWork, type ProfileWorkPlace } from "./spade-profile-work.tsx";
import type { SpadeWork } from "./use-spade-work.ts";
import { VoiceRows } from "./spade-voice-settings.tsx";
import { useSpadeModels } from "./use-spade-models.ts";
import { voiceKey } from "./use-spoken-replies.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** A group's small heading, with an action at its right when there is one. */
function GroupHeading(props: { children: string; action?: React.ReactNode }) {
  return (
    <div className="mx-1 mb-1.5 flex min-h-6 items-center">
      <h3 className="text-ui text-muted-foreground">{props.children}</h3>
      {props.action && <div className="ml-auto">{props.action}</div>}
    </div>
  );
}

const hiddenKey = (bot: RosterBot) => `ace.spade.suggested-hidden.${bot.machine.key}/${bot.id}`;

/** Suggested stays hidden once the person hid it, for this bot, in this browser. */
function useHiddenSuggestions(bot: RosterBot) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(hiddenKey(bot)) === "1";
    } catch {
      return false;
    }
  });
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(hiddenKey(bot), "1");
    } catch {
      // Not remembered; it still hides for now.
    }
  };
  return [hidden, hide] as const;
}

/**
 * Activity: what the bot is working toward (its goal, workers and decisions, when it has any),
 * what Spade suggests (a routine, the apps that fit its task), its computer and its voice. Each
 * is a rounded group with a small heading; the computer opens full screen.
 */
export function ProfileActivity(props: {
  bot: RosterBot;
  work: SpadeWork;
  workPlace: ProfileWorkPlace;
  computer: ProfileComputerPlace;
  /** Opens a surface of its computer in the panel. */
  onOpenSurface(kind: "terminal" | "screen" | "browser"): void;
  /** Opens the New routine page. */
  onNewRoutine(): void;
}) {
  const { bot } = props;
  const [hidden, hide] = useHiddenSuggestions(bot);
  const speechModel = useSpadeModels(true).data?.speechModel;
  return (
    <div className="flex flex-col gap-6">
      <ProfileWork bot={bot} work={props.work} place={props.workPlace} />
      <ProfileRoutineRows bot={bot} />
      {!hidden && (
        <section aria-label="Suggested">
          <GroupHeading
            action={
              <button
                type="button"
                onClick={hide}
                className="rounded-full px-1.5 text-ui text-muted-foreground focus-ring hover:text-foreground"
              >
                Hide
              </button>
            }
          >
            Suggested
          </GroupHeading>
          <SettingCard>
            <button
              type="button"
              data-setting-slot=""
              {...part("list-row", undefined, "suggested")}
              onClick={props.onNewRoutine}
              className="flex min-h-11 w-full items-center gap-3 text-left text-ui text-foreground focus-ring"
            >
              <Icon icon={ClockIcon} size={16} className="text-muted-foreground" />
              <span className="flex-1">Create a routine</span>
              <Icon icon={CaretRightIcon} size={14} className="text-muted-foreground" />
            </button>
            <SuggestedApps task={bot.task} botId={bot.id} title="Apps that fit" />
          </SettingCard>
        </section>
      )}
      <section aria-label="Computer">
        <GroupHeading>Computer</GroupHeading>
        <ComputerCard bot={bot} place={props.computer} onOpenSurface={props.onOpenSurface} />
      </section>
      <section aria-label="Voice chat">
        <GroupHeading>Voice chat</GroupHeading>
        <SettingCard>
          <VoiceRows bot={voiceKey(bot.machine.key, bot.id)} speechModel={speechModel} />
        </SettingCard>
      </section>
    </div>
  );
}
