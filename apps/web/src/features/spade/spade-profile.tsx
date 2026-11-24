import { CaretLeftIcon, ExportIcon, GearSixIcon, XIcon } from "@ace/icons";
import { useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { ComputerFullscreen } from "./computer/computer-fullscreen.tsx";
import type { ProfileComputerPlace } from "./computer/profile-computer.tsx";
import type { ProfileTab } from "./computer/panel-place.ts";
import type { ProfilePanels } from "./spade-profile-details.tsx";
import { ProfileActivity } from "./spade-profile-activity.tsx";
import { ProfileHead } from "./spade-profile-head.tsx";
import { ProfileLibrary } from "./spade-profile-library.tsx";
import { PanelSurfaceView, type PanelSurface } from "./spade-panel-surface.tsx";
import { ProfileSettings, type SettingsPage } from "./spade-profile-settings.tsx";
import { NewRoutinePage } from "./spade-routine-new.tsx";
import type { ProfileWorkPlace } from "./spade-profile-work.tsx";
import { useSpadeWork } from "./use-spade-work.ts";
import type { SpadeDecision } from "@ace/ui-core/spade-chat";
import { roundButton } from "./spade-profile-parts.tsx";
import { useShareBot } from "./spade-profile-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Share, as the conversation's top bar holds it above a docked profile. */
export function ProfileShareButton(props: { bot: RosterBot; round?: boolean }) {
  const share = useShareBot();
  return (
    <IconButton
      icon={ExportIcon}
      label={`Share ${props.bot.name}`}
      tip="Share"
      size="default"
      onClick={() => void share(props.bot)}
      className={props.round ? roundButton : undefined}
    />
  );
}

/** Close, as the profile's own head holds it. */
function CloseProfileButton(props: { onClose(): void; round?: boolean }) {
  return (
    <IconButton
      icon={XIcon}
      label="Close profile"
      tip="Close"
      size="default"
      onClick={props.onClose}
      className={props.round ? roundButton : undefined}
    />
  );
}

/** Share and close together, where the profile takes the window and leads its own strip. */
export function ProfileStripActions(props: { bot: RosterBot; onClose(): void; round?: boolean }) {
  return (
    <>
      <ProfileShareButton bot={props.bot} round={props.round ?? false} />
      <CloseProfileButton onClose={props.onClose} round={props.round ?? false} />
    </>
  );
}

/** What the panel shows: the route's tab, as Activity, Library or Settings. */
type Shown = "activity" | "library" | "settings";
const shownOf = (tab: ProfileTab): Shown =>
  tab === "library"
    ? "library"
    : tab === "details" || tab === "permissions"
      ? "settings"
      : "activity";
const segments: readonly { id: "activity" | "library"; tab: ProfileTab; name: string }[] = [
  { id: "activity", tab: "work", name: "Activity" },
  { id: "library", tab: "library", name: "Library" },
];

/**
 * A bot's profile (docs/design/spade.md §4), ace's side panel beside its conversation: its face
 * (a picker) and name, Settings and close at the head, then Activity and Library as a small
 * segmented control. Settings holds everything else, one scrolling view with a back arrow. The
 * computer opens over the whole window (route tab `computer`). The person keeps talking while
 * they change the bot. Where the window is too narrow for both (`covering`) it takes the window,
 * its strip led by ‹ Chat.
 */
export function SpadeProfile(props: {
  bot: RosterBot;
  tab: ProfileTab;
  onTab(tab: ProfileTab): void;
  computer: ProfileComputerPlace;
  work: ProfileWorkPlace & { decisions: readonly SpadeDecision[] };
  /** Its package's panels, listed in Settings. */
  panels?: ProfilePanels | undefined;
  covering: boolean;
  onClose(): void;
}) {
  const { bot } = props;
  const work = useSpadeWork(bot, props.work.decisions);
  const shown = shownOf(props.tab);
  const tabs = useRef<HTMLDivElement>(null);
  const ids = { tab: (each: string) => `profile-tab-${each}`, panel: "profile-panel" };
  // Arrow keys move between the two tabs, as a tab list does.
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = segments.find((each) => each.id !== shown);
    if (!next) return;
    event.preventDefault();
    props.onTab(next.tab);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  const settings = shown === "settings";
  // Which settings page is open belongs to the tab it was opened on; the old Permissions link
  // opens Can use. A New routine page, opened from Activity or Routines, goes back to either.
  const [opened, setOpened] = useState<{ tab: ProfileTab; page: SettingsPage | undefined }>();
  const page =
    opened?.tab === props.tab
      ? opened.page
      : props.tab === "permissions"
        ? ("can-use" as const)
        : undefined;
  const [newRoutine, setNewRoutine] = useState(false);
  // A file, the terminal, the screen or the browser, open in the panel in place of its tabs.
  const [surface, setSurface] = useState<PanelSurface>();
  const expand = (open: PanelSurface) =>
    open.kind === "files"
      ? props.computer.onView("files", open.at)
      : props.computer.onView(open.kind);
  return (
    <section
      aria-label={`${bot.name}'s profile`}
      {...part("right-panel", undefined, "spade-profile")}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        // Esc goes back to the tab, unless the person is typing into the surface (its terminal,
        // an editor): there it is the surface's own key.
        if (event.key !== "Escape" || event.defaultPrevented || !surface) return;
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("textarea, input, [contenteditable]"))
          return;
        setSurface(undefined);
      }}
    >
      {props.covering && (
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          <button
            type="button"
            aria-label="Back to chat"
            onClick={props.onClose}
            className="-ml-2 mr-auto flex h-8 items-center gap-1 rounded-full pr-3 pl-2 text-ui font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground"
          >
            <Icon icon={CaretLeftIcon} size={16} />
            Chat
          </button>
          <ProfileStripActions bot={bot} onClose={props.onClose} round />
        </div>
      )}
      {/* Never sideways: what is wider than the panel wraps or scrolls in its own frame. */}
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        {!settings && !newRoutine && !surface && (
          <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
            <IconButton
              icon={GearSixIcon}
              label="Settings"
              size="default"
              className={roundButton}
              onClick={() => props.onTab("details")}
            />
            {!props.covering && <CloseProfileButton onClose={props.onClose} round />}
          </div>
        )}
        {surface && !newRoutine && !settings ? (
          <div className="flex h-full flex-col">
            <PanelSurfaceView
              bot={bot}
              surface={surface}
              place={props.computer}
              onBack={() => setSurface(undefined)}
              onExpand={() => expand(surface)}
            />
          </div>
        ) : newRoutine ? (
          <div className="px-4 pt-4 pb-8">
            <NewRoutinePage
              bot={bot}
              onBack={() => setNewRoutine(false)}
              onCreated={() => setNewRoutine(false)}
            />
          </div>
        ) : settings ? (
          <div className="px-4 pt-4 pb-8">
            <ProfileSettings
              bot={bot}
              panels={props.panels}
              page={page}
              onPage={(next) => setOpened({ tab: props.tab, page: next })}
              onNewRoutine={() => setNewRoutine(true)}
              onBack={() => props.onTab("work")}
            />
          </div>
        ) : (
          <>
            <ProfileHead key={`${bot.machine.key}/${bot.id}`} bot={bot} />
            <div className="mx-4 mb-6 flex justify-center">
              <div
                ref={tabs}
                role="tablist"
                aria-label="Profile"
                {...part("segmented", undefined, "profile")}
                onKeyDown={move}
                className="inline-flex items-center gap-1"
              >
                {segments.map((each) => {
                  const selected = each.id === shown;
                  return (
                    <button
                      key={each.id}
                      type="button"
                      role="tab"
                      id={ids.tab(each.id)}
                      data-tab={each.id}
                      aria-selected={selected}
                      aria-controls={ids.panel}
                      {...part("segment", selected && "selected", each.id)}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => props.onTab(each.tab)}
                      className={cn(
                        "h-8 rounded-full px-3 text-ui font-medium whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring",
                        selected
                          ? "bg-surface-1 text-foreground"
                          : "text-muted-foreground hover:bg-hover hover:text-foreground",
                      )}
                    >
                      {each.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              role="tabpanel"
              id={ids.panel}
              aria-labelledby={ids.tab(shown)}
              {...part("panel-body", "active", shown)}
              className="flex flex-col px-4 pb-8"
            >
              {shown === "library" ? (
                <ProfileLibrary bot={bot} onOpenFile={(at) => setSurface({ kind: "files", at })} />
              ) : (
                <ProfileActivity
                  bot={bot}
                  work={work}
                  workPlace={props.work}
                  computer={props.computer}
                  onNewRoutine={() => setNewRoutine(true)}
                  onOpenSurface={(kind) => setSurface({ kind })}
                />
              )}
            </div>
          </>
        )}
      </div>
      {props.tab === "computer" && (
        <ComputerFullscreen bot={bot} place={props.computer} onClose={() => props.onTab("work")} />
      )}
    </section>
  );
}
