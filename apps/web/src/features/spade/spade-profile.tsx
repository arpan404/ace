import { CaretLeftIcon, ExportIcon, XIcon } from "@ace/icons";
import { useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { ProfileComputer, type ProfileComputerPlace } from "./computer/profile-computer.tsx";
import { profileTabNames, profileTabs, type ProfileTab } from "./computer/panel-place.ts";
import {
  ProfileDetails,
  ProfilePermissions,
  type ProfilePanels,
} from "./spade-profile-details.tsx";
import { ProfileHead } from "./spade-profile-head.tsx";
import { ProfileLibrary } from "./spade-profile-library.tsx";
import { ProfileWork, type ProfileWorkPlace } from "./spade-profile-work.tsx";
import { useSpadeWork } from "./use-spade-work.ts";
import type { SpadeDecision } from "@ace/ui-core/spade-chat";
import { roundButton } from "./spade-profile-parts.tsx";
import { useShareBot } from "./spade-profile-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * Share and close, as the profile's strip holds them. Docked beside the chat they sit in the
 * top bar's part above the profile; where the profile takes the window they lead its own strip.
 */
export function ProfileStripActions(props: { bot: RosterBot; onClose(): void; round?: boolean }) {
  const share = useShareBot();
  const className = props.round ? roundButton : undefined;
  return (
    <>
      <IconButton
        icon={ExportIcon}
        label={`Share ${props.bot.name}`}
        tip="Share"
        size={props.round ? "panel" : "default"}
        onClick={() => void share(props.bot)}
        className={className}
      />
      <IconButton
        icon={XIcon}
        label="Close profile"
        tip="Close"
        size={props.round ? "panel" : "default"}
        onClick={props.onClose}
        className={className}
      />
    </>
  );
}

/**
 * A bot's profile (docs/design/spade.md §4), ace's side panel beside its conversation: its face
 * and name, edited in place, then Details · Work · Library · Computer as a segmented control; Work
 * only while the bot has a goal, workers or decisions. The person
 * keeps talking while they change the bot and watches its computer beside the chat. Where the
 * window is too narrow for both (`covering`) it takes the window, its strip led by ‹ Chat.
 */
export function SpadeProfile(props: {
  bot: RosterBot;
  tab: ProfileTab;
  onTab(tab: ProfileTab): void;
  computer: ProfileComputerPlace;
  work: ProfileWorkPlace & { decisions: readonly SpadeDecision[] };
  /** Its package's panels, listed on Details. */
  panels?: ProfilePanels | undefined;
  covering: boolean;
  onClose(): void;
}) {
  const { bot } = props;
  const work = useSpadeWork(bot, props.work.decisions);
  // Work is there while there is work; on it while its reads are out, it stays rather than jump.
  const hasWork = work.shown || (props.tab === "work" && work.pending);
  const shownTabs = hasWork ? profileTabs : profileTabs.filter((each) => each !== "work");
  const tab = shownTabs.includes(props.tab) ? props.tab : "details";
  const tabs = useRef<HTMLDivElement>(null);
  const ids = { tab: (each: ProfileTab) => `profile-tab-${each}`, panel: "profile-panel" };
  // Arrow keys move between the tabs, as a tab list does.
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const at = shownTabs.indexOf(tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = shownTabs[(at + step + shownTabs.length) % shownTabs.length];
    if (!next) return;
    event.preventDefault();
    props.onTab(next);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
  return (
    <section
      aria-label={`${bot.name}'s profile`}
      {...part("right-panel", undefined, "spade-profile")}
      className="flex h-full min-h-0 flex-col"
    >
      {props.covering && (
        <div className="flex h-11 shrink-0 items-center gap-2 px-2">
          <button
            type="button"
            aria-label="Back to chat"
            onClick={props.onClose}
            className="mr-auto flex h-8 items-center gap-1 rounded-full pr-3 pl-2 text-ui font-medium text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
          >
            <Icon icon={CaretLeftIcon} size={16} />
            Chat
          </button>
          <ProfileStripActions bot={bot} onClose={props.onClose} round />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <ProfileHead key={`${bot.machine.key}/${bot.id}`} bot={bot} />
        <div
          ref={tabs}
          role="tablist"
          aria-label="Profile"
          {...part("segmented", undefined, "profile")}
          onKeyDown={move}
          className="mx-4 mb-4 flex gap-0.5 rounded-full bg-hover p-0.5"
        >
          {shownTabs.map((each) => {
            const selected = each === tab;
            return (
              <button
                key={each}
                type="button"
                role="tab"
                id={ids.tab(each)}
                data-tab={each}
                aria-selected={selected}
                aria-controls={ids.panel}
                {...part("segment", selected && "selected", each)}
                tabIndex={selected ? 0 : -1}
                onClick={() => props.onTab(each)}
                className={cn(
                  "h-8 flex-1 rounded-full text-ui font-medium transition-colors duration-(--motion-fast) focus-ring",
                  selected
                    ? "bg-background text-foreground shadow-[0_0_0_1px_var(--border)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {profileTabNames[each]}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={ids.panel}
          aria-labelledby={ids.tab(tab)}
          {...part("panel-body", "active", tab)}
          className="flex flex-col px-4 pb-8"
        >
          {tab === "details" ? (
            <ProfileDetails bot={bot} panels={props.panels} />
          ) : tab === "permissions" ? (
            <ProfilePermissions bot={bot} />
          ) : tab === "work" ? (
            <ProfileWork bot={bot} work={work} place={props.work} />
          ) : tab === "library" ? (
            <ProfileLibrary
              bot={bot}
              onOpenFile={(files) => props.computer.onView("files", files)}
            />
          ) : (
            <ProfileComputer bot={bot} place={props.computer} />
          )}
        </div>
      </div>
    </section>
  );
}
