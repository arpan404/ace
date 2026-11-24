import { CaretRightIcon, ClockIcon } from "@ace/icons";
import { useId, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { ComputerCard } from "./computer/computer-card.tsx";
import type { ProfileComputerPlace } from "./computer/profile-computer.tsx";
import {
  ProfileCard,
  ProfileSectionHeader,
  profileRowClass,
  sectionActionClass,
} from "./spade-profile-parts.tsx";
import { ProfileRoutineRows } from "./spade-profile-routine-rows.tsx";
import { SuggestedApps } from "./spade-suggested-apps.tsx";
import { ProfileWork, type ProfileWorkPlace } from "./spade-profile-work.tsx";
import { canReadAloud } from "./spade-speech.ts";
import { endpointVoices } from "./spade-voice-models.ts";
import { botVoice, setVoiceChoice, useVoicePrefs } from "./spade-voice-prefs.ts";
import { useSystemVoices } from "./spade-voice-settings.tsx";
import { useSpadeModels } from "./use-spade-models.ts";
import { voiceKey } from "./use-spoken-replies.ts";
import type { SpadeWork } from "./use-spade-work.ts";
import type { RosterBot } from "./use-spade-roster.ts";

const hiddenKey = (bot: RosterBot) => `ace.spade.suggested-hidden.${bot.machine.key}/${bot.id}`;
const followVoice = "";
const titled = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

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

/** Compact Voice chat card: Speak replies toggle + right-aligned Voice picker on clean 44px rows. */
function ActivityVoiceCard(props: { bot: string; speechModel: string | undefined }) {
  const { bot, speechModel } = props;
  const switchId = useId();
  const prefs = useVoicePrefs();
  const system = useSystemVoices();
  const own = prefs.bots[bot] ?? {};
  const effective = botVoice(prefs, bot);
  const canSpeak = speechModel !== undefined || canReadAloud();
  const field = speechModel ? "endpointVoice" : "systemVoice";
  const chosen = own[field];
  const defaults = botVoice(prefs, undefined)[field];
  const language = (typeof navigator === "undefined" ? "" : navigator.language).split("-")[0];
  const options: SelectOption<string>[] = speechModel
    ? endpointVoices.map((voice) => ({ value: voice, label: titled(voice) }))
    : system
        .toSorted(
          (a, b) =>
            Number(b.lang.startsWith(language ?? "")) - Number(a.lang.startsWith(language ?? "")) ||
            a.name.localeCompare(b.name),
        )
        .map((voice) => ({ value: voice.voiceURI, label: `${voice.name} · ${voice.lang}` }));
  const named = (value: string | undefined) =>
    options.find((option) => option.value === value)?.label;
  const first: SelectOption<string> = {
    value: followVoice,
    label: `Default (${named(defaults) ?? (speechModel ? "Alloy" : "System")})`,
  };
  return (
    <ProfileCard>
      <div
        data-setting-slot=""
        className="flex min-h-11 items-center gap-3 px-4 py-2 transition-colors duration-(--motion-fast) hover:bg-hover"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <label
            htmlFor={switchId}
            className="w-fit cursor-pointer truncate text-ui font-medium text-foreground"
          >
            Speak replies
          </label>
          {!canSpeak && (
            <span className="truncate text-xs text-muted-foreground">
              No speech available on this device
            </span>
          )}
        </div>
        <Switch
          id={switchId}
          checked={effective.speakReplies}
          disabled={!canSpeak}
          onCheckedChange={(checked) => setVoiceChoice(bot, { speakReplies: checked })}
        />
      </div>
      {canSpeak && (
        <div
          data-setting-slot=""
          className="flex min-h-11 items-center gap-3 px-4 py-2 transition-colors duration-(--motion-fast) hover:bg-hover"
        >
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
            Voice
          </span>
          <Select<string>
            label="Voice"
            className="max-w-44"
            value={chosen ?? followVoice}
            options={[first, ...options.filter((option) => option.value !== followVoice)]}
            onValueChange={(value) => setVoiceChoice(bot, { [field]: value || undefined })}
          />
        </div>
      )}
    </ProfileCard>
  );
}

/**
 * Activity: active work (goal, plan, decisions) and routines when present, then Computer (live
 * thumbnail + surfaces), Suggested (routine + fitting apps) and Voice chat. Every section is a
 * 12px rounded group under a quiet 12px muted heading, spaced on the 24px section rhythm.
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
      <section aria-label="Computer">
        <ProfileSectionHeader>Computer</ProfileSectionHeader>
        <ComputerCard bot={bot} place={props.computer} onOpenSurface={props.onOpenSurface} />
      </section>
      {!hidden && (
        <section aria-label="Suggested">
          <ProfileSectionHeader
            actions={
              <button type="button" onClick={hide} className={cn(sectionActionClass, "-mr-2")}>
                Hide
              </button>
            }
          >
            Suggested
          </ProfileSectionHeader>
          <ProfileCard>
            <button
              type="button"
              data-setting-slot=""
              {...part("list-row", undefined, "suggested")}
              onClick={props.onNewRoutine}
              className={cn(profileRowClass, "min-h-11 py-2 text-ui font-medium text-foreground")}
            >
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                <Icon icon={ClockIcon} size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate">Create a routine</span>
              <Icon icon={CaretRightIcon} size={16} className="shrink-0 text-faint-foreground" />
            </button>
            <SuggestedApps task={bot.task} botId={bot.id} title="Apps that fit" embedded />
          </ProfileCard>
        </section>
      )}
      <section aria-label="Voice chat">
        <ProfileSectionHeader>Voice chat</ProfileSectionHeader>
        <ActivityVoiceCard bot={voiceKey(bot.machine.key, bot.id)} speechModel={speechModel} />
      </section>
    </div>
  );
}
