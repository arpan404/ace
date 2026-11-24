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
  spadeModelLabel,
  spadeMoney,
  spadePermissionSwitches,
  spadePersonalityWords,
  spadeQuietPersonality,
} from "@ace/ui-core/spade-chat";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
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
import { ProfileSection, profileRowClass } from "./spade-profile-parts.tsx";
import { ProfilePersonality } from "./spade-profile-personality.tsx";
import { ProfileWorkLog } from "./spade-profile-work.tsx";
import { ProfileRoutines } from "./spade-routines.tsx";
import { useBotSecurity } from "./spade-security-api.ts";
import { botVoice, useVoicePrefs } from "./spade-voice-prefs.ts";
import { useSpadeModels } from "./use-spade-models.ts";
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

interface PageEntry {
  id: SettingsPage;
  title: string;
  icon: IconGlyph;
}

const groups: readonly { label: string; pages: readonly PageEntry[] }[] = [
  {
    label: "Bot",
    pages: [
      { id: "job", title: "Job", icon: BriefcaseIcon },
      { id: "model", title: "Model", icon: CpuIcon },
      { id: "personality", title: "Personality", icon: PaletteIcon },
      { id: "voice", title: "Voice", icon: SpeakerHighIcon },
    ],
  },
  {
    label: "Access and automation",
    pages: [
      { id: "decides", title: "How it decides", icon: ShieldCheckIcon },
      { id: "can-use", title: "Can use", icon: KeyIcon },
      { id: "routines", title: "Routines", icon: ClockIcon },
      { id: "files", title: "Files and folders", icon: FolderIcon },
    ],
  },
  {
    label: "Oversight",
    pages: [
      { id: "safety", title: "Activity and safety", icon: ShieldIcon },
      { id: "making", title: "Making bots", icon: RobotIcon },
    ],
  },
];

const allPages = groups.flatMap((group) => group.pages);
const titleOf = (page: SettingsPage) => allPages.find((each) => each.id === page)?.title ?? "";
const makingWords = { yes: "Yes", ask: "Ask me first", no: "No" } as const;

/** What each category row says at its right: one short fact about the bot as it is now. */
function useCategoryValues(bot: RosterBot): Record<SettingsPage, string | undefined> {
  const security = useBotSecurity(bot.id).data;
  const routines = useSpadeRoutines(bot.id);
  const voice = botVoice(useVoicePrefs(), voiceKey(bot.machine.key, bot.id));
  const endpoints = useSpadeModels(true).data?.endpoints ?? [];
  const modelName = spadeModelLabel(
    { endpoints: endpoints.map((endpoint) => ({ endpoint, models: endpoint.models })) },
    bot.model,
  ).name;
  const switches = security?.permissions
    ? spadePermissionSwitches
        .filter((each) => security.permissions?.on[each.key])
        .map((each) => each.title)
    : [];
  const count = routines.routines.data?.length;
  const beat = routines.heartbeat.data;
  const personality = parseSpadePersonality(bot.raw.personality) ?? spadeQuietPersonality;
  const isDefaultPersonality = !personality.tone && !personality.humour && !personality.emoji;
  const folders = security?.folders.length;
  const routineSummary =
    count === undefined
      ? undefined
      : count === 0
        ? beat?.enabled
          ? "Heartbeat on"
          : "None"
        : beat?.enabled
          ? `${count} · Heartbeat on`
          : `${count} ${count === 1 ? "routine" : "routines"}`;
  const canUseSummary =
    switches.length === 0
      ? security
        ? "Nothing extra"
        : undefined
      : switches.length <= 2
        ? switches.join(", ")
        : `${switches[0]}, +${switches.length - 1}`;
  return {
    job: bot.task.trim().split("\n")[0]?.trim() || "Not set",
    model: modelName || bot.model.split("/").at(-1) || undefined,
    decides: security
      ? security.autonomy === "full_access"
        ? "Full access"
        : "Auto-review"
      : undefined,
    "can-use": canUseSummary,
    personality: isDefaultPersonality
      ? "Its own way"
      : spadePersonalityWords(personality) || "Its own way",
    voice: voice.speakReplies ? (voice.endpointVoice ?? voice.systemVoice ?? "Default") : "Off",
    routines: routineSummary,
    files:
      folders === undefined
        ? undefined
        : folders
          ? `${folders} ${folders === 1 ? "folder" : "folders"}`
          : "None",
    safety: bot.spending ? spadeMoney(bot.spending.monthMicros) : undefined,
    making: makingWords[bot.mayCreateBots],
  };
}

/**
 * Settings: grouped categories, each row a short page (its value at the right, a caret),
 * and below them, apart, what is done to the bot itself: Duplicate, Export, Delete. A page opens
 * in the panel with a back arrow to this list; the list's own back goes to where the person was.
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
        <div className="flex flex-col gap-5 *:mt-0!">
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
      <div className="flex flex-col gap-5 *:mt-0!">
        {groups.map((group) => (
          <ProfileSection key={group.label} label={group.label} flush>
            {group.pages.map((each) => {
              const value = values[each.id];
              return (
                <button
                  key={each.id}
                  type="button"
                  data-setting-slot=""
                  onClick={() => props.onPage(each.id)}
                  className={cn(profileRowClass, "min-h-11 py-2.5")}
                >
                  <Icon icon={each.icon} size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                    {each.title}
                  </span>
                  {value && (
                    <span className="max-w-36 shrink-0 truncate text-xs text-muted-foreground tabular-nums">
                      {value}
                    </span>
                  )}
                  <Icon
                    icon={CaretRightIcon}
                    size={13}
                    className="shrink-0 text-subtle-foreground"
                  />
                </button>
              );
            })}
          </ProfileSection>
        ))}
        <ProfileBotActions bot={bot} />
      </div>
    </ProfilePage>
  );
}
