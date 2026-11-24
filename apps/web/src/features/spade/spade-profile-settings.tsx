import {
  BriefcaseIcon,
  CaretRightIcon,
  ClockIcon,
  CpuIcon,
  FolderIcon,
  KeyIcon,
  PaletteIcon,
  RobotIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SpeakerHighIcon,
} from "@ace/icons";
import {
  parseSpadePersonality,
  spadePermissionSwitches,
  spadePersonalityWords,
  spadeQuietPersonality,
} from "@ace/ui-core/spade-chat";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { SettingCard } from "@/components/setting-row.tsx";
import { ProfileSwitchesAndApps } from "./spade-settings-can-use.tsx";
import { ProfileDecides, ProfileFilesAndGrants, ProfileSafetyLogs } from "./spade-bot-security.tsx";
import { ProfileSpending } from "./spade-bot-oversight.tsx";
import { ProfileReach } from "./spade-bot-reach.tsx";
import {
  ProfileBotActions,
  ProfileJob,
  ProfileMakesBots,
  ProfileModel,
  ProfileRunning,
  ProfileVoice,
  type ProfilePanels,
} from "./spade-profile-details.tsx";
import { ProfileCases } from "./spade-profile-cases.tsx";
import { ProfilePage } from "./spade-profile-page.tsx";
import { ProfilePersonality } from "./spade-profile-personality.tsx";
import { ProfileWorkLog } from "./spade-profile-work.tsx";
import { ProfileRoutines } from "./spade-routines.tsx";
import { useBotSecurity } from "./spade-security-api.ts";
import { botVoice, useVoicePrefs } from "./spade-voice-prefs.ts";
import { voiceKey } from "./use-spoken-replies.ts";
import { useSpadeRoutines } from "./use-spade-routines.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** The settings pages, one short page per category. */
export type SettingsPage =
  | "job"
  | "model"
  | "decides"
  | "can-use"
  | "personality"
  | "voice"
  | "routines"
  | "files"
  | "safety"
  | "making";

const pages: readonly { id: SettingsPage; title: string; icon: IconGlyph }[] = [
  { id: "job", title: "Job", icon: BriefcaseIcon },
  { id: "model", title: "Model", icon: CpuIcon },
  { id: "decides", title: "How it decides", icon: ShieldCheckIcon },
  { id: "can-use", title: "Can use", icon: KeyIcon },
  { id: "personality", title: "Personality", icon: PaletteIcon },
  { id: "voice", title: "Voice", icon: SpeakerHighIcon },
  { id: "routines", title: "Routines", icon: ClockIcon },
  { id: "files", title: "Files and folders", icon: FolderIcon },
  { id: "safety", title: "Activity and safety", icon: ShieldIcon },
  { id: "making", title: "Making bots", icon: RobotIcon },
];

const titleOf = (page: SettingsPage) => pages.find((each) => each.id === page)?.title ?? "";

const titled = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const makingWords = { yes: "Yes", ask: "Ask me first", no: "No" } as const;

/** What each category row says at its right: one short fact about the bot as it is now. */
function useCategoryValues(bot: RosterBot): Record<SettingsPage, string | undefined> {
  const security = useBotSecurity(bot.id).data;
  const routines = useSpadeRoutines(bot.id);
  const voice = botVoice(useVoicePrefs(), voiceKey(bot.machine.key, bot.id));
  const parts = bot.model.split("/");
  const switches = security?.permissions
    ? spadePermissionSwitches
        .filter((each) => security.permissions?.on[each.key])
        .map((each) => each.title)
    : [];
  const count = routines.routines.data?.length;
  const beat = routines.heartbeat.data;
  const personality = parseSpadePersonality(bot.raw.personality) ?? spadeQuietPersonality;
  const folders = security?.folders.length;
  return {
    job: bot.task.trim().split("\n")[0]?.trim() || "Not set",
    model: [parts[0] ? titled(parts[0]) : undefined, parts.at(-1), bot.machine.name]
      .filter(Boolean)
      .join(" · "),
    decides: security
      ? security.autonomy === "full_access"
        ? "Full access"
        : "Auto-review"
      : undefined,
    "can-use": switches.length
      ? switches.slice(0, 2).join(", ")
      : security
        ? "Nothing extra"
        : undefined,
    personality: spadePersonalityWords(personality) || "Its own way",
    voice: voice.speakReplies ? (voice.endpointVoice ?? voice.systemVoice ?? "Default") : "Off",
    routines:
      count === undefined
        ? undefined
        : `${count} ${count === 1 ? "routine" : "routines"} · Heartbeat ${beat?.enabled ? "on" : "off"}`,
    files:
      folders === undefined
        ? undefined
        : folders
          ? `${folders} ${folders === 1 ? "folder" : "folders"}`
          : "None",
    safety: undefined,
    making: makingWords[bot.mayCreateBots],
  };
}

/**
 * Settings: the categories as one list, each row a short page (its value at the right, a caret),
 * and below it, apart, what is done to the bot itself: Duplicate, Export, Delete. A page opens in
 * the panel with a back arrow to this list; the list's own back goes to where the person was.
 */
export function ProfileSettings(props: {
  bot: RosterBot;
  panels?: ProfilePanels | undefined;
  page: SettingsPage | undefined;
  onPage(page: SettingsPage | undefined): void;
  onNewRoutine(): void;
  onBack(): void;
}) {
  const { bot, page } = props;
  const values = useCategoryValues(bot);
  if (page)
    return (
      <ProfilePage title={titleOf(page)} onBack={() => props.onPage(undefined)}>
        <div className="flex flex-col gap-6 *:mt-0!">
          {page === "job" && <ProfileJob bot={bot} panels={props.panels} />}
          {page === "model" && <ProfileModel bot={bot} />}
          {page === "decides" && <ProfileDecides bot={bot} />}
          {page === "can-use" && <ProfileSwitchesAndApps bot={bot} />}
          {page === "personality" && <ProfilePersonality bot={bot} />}
          {page === "voice" && <ProfileVoice bot={bot} />}
          {page === "routines" && <ProfileRoutines bot={bot} onNew={props.onNewRoutine} />}
          {page === "files" && <ProfileFilesAndGrants bot={bot} />}
          {page === "safety" && (
            <>
              {bot.kind === "main" && <ProfileRunning />}
              <ProfileSpending bot={bot} />
              <ProfileSafetyLogs bot={bot} />
              <ProfileCases bot={bot} />
              <ProfileReach bot={bot} />
              <ProfileWorkLog bot={bot} />
            </>
          )}
          {page === "making" && <ProfileMakesBots bot={bot} />}
        </div>
      </ProfilePage>
    );
  return (
    <ProfilePage title="Settings" onBack={props.onBack}>
      <SettingCard>
        {pages.map((each) => {
          const value = values[each.id];
          return (
            <button
              key={each.id}
              type="button"
              data-setting-slot=""
              onClick={() => props.onPage(each.id)}
              className="flex min-h-11 w-full items-center gap-3 text-left text-ui text-foreground focus-ring-inset"
            >
              <Icon icon={each.icon} size={16} className="shrink-0 text-muted-foreground" />
              <span className="flex-1">{each.title}</span>
              {value && <span className="max-w-44 truncate text-muted-foreground">{value}</span>}
              <Icon icon={CaretRightIcon} size={14} className="text-muted-foreground" />
            </button>
          );
        })}
      </SettingCard>
      <ProfileBotActions bot={bot} />
    </ProfilePage>
  );
}
