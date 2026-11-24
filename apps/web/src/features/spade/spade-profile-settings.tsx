import { CaretRightIcon } from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
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

const pages: readonly { id: SettingsPage; title: string }[] = [
  { id: "job", title: "Job" },
  { id: "model", title: "Model" },
  { id: "decides", title: "How it decides" },
  { id: "can-use", title: "Can use" },
  { id: "personality", title: "Personality" },
  { id: "voice", title: "Voice" },
  { id: "routines", title: "Routines" },
  { id: "files", title: "Files and folders" },
  { id: "safety", title: "Activity and safety" },
  { id: "making", title: "Making bots" },
];

const titleOf = (page: SettingsPage) => pages.find((each) => each.id === page)?.title ?? "";

/** What a category row says at its right, when that is one short fact. */
function valueOf(page: SettingsPage, bot: RosterBot, routines: number | undefined) {
  if (page === "model") return bot.model.split("/").at(-1);
  if (page === "routines") return routines === undefined ? undefined : String(routines);
  if (page === "job") return bot.task ? bot.task.slice(0, 24) : undefined;
  return undefined;
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
  const routines = useSpadeRoutines(bot.id).routines.data?.length;
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
          const value = valueOf(each.id, bot, routines);
          return (
            <button
              key={each.id}
              type="button"
              data-setting-slot=""
              onClick={() => props.onPage(each.id)}
              className="flex min-h-11 w-full items-center gap-3 text-left text-ui text-foreground focus-ring-inset"
            >
              <span className="flex-1">{each.title}</span>
              {value && <span className="max-w-32 truncate text-muted-foreground">{value}</span>}
              <Icon icon={CaretRightIcon} size={14} className="text-muted-foreground" />
            </button>
          );
        })}
      </SettingCard>
      <ProfileBotActions bot={bot} />
    </ProfilePage>
  );
}
