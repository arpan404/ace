import { FoldersIcon, GearSixIcon } from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { railPlaceClass } from "@/components/rail-place.ts";
import { Tip, TooltipSide } from "@/components/ui/tooltip.tsx";
import { useAceAccount } from "@/features/ace-account/index.ts";
import { useProfileName } from "@/lib/profile.ts";
import { NavButtons } from "./app-header.tsx";
import { panelCanvasClass } from "./canvas.ts";
import { useViewFrame } from "./sidebar-frame.tsx";
import { UpdateButton } from "./update-button.tsx";
import { PanelHeader } from "./view-frame.tsx";

/**
 * The sidebar of a window with no machine: the same top row, rail and panel as the app's
 * (`AppSidebar`), with only the places that work without one: Threads (which says to add a
 * machine), Settings, the app's update and the profile. Settings draws its list into the panel.
 */
export function NoMachineSidebar() {
  const { setBody, bodyClaimed, sheet } = useViewFrame();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="sidebar-top"
        className="flex h-(--header-h) shrink-0 items-center gap-0.5 pl-3 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]"
      >
        {!sheet && <NavButtons />}
      </div>
      <div data-slot="sidebar-body" className="flex min-h-0 flex-1">
        <NoMachineRail />
        <div
          data-slot="sidebar-panel"
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${sheet ? "" : panelCanvasClass}`}
        >
          {!bodyClaimed && <PanelHeader title="Threads" />}
          <div ref={setBody} className="contents" />
        </div>
      </div>
    </div>
  );
}

function NoMachineRail() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const settings = pathname.startsWith("/settings") || pathname === "/pair";
  const profile = pathname === "/settings/profile";
  const [profileName] = useProfileName();
  const { session } = useAceAccount();
  const name = session?.account.name || profileName;
  return (
    <nav
      aria-label="App"
      data-slot="rail"
      className="flex w-(--rail-width) shrink-0 flex-col items-center gap-1 pt-0.5 pb-2.5"
    >
      <TooltipSide value="right">
        <Tip label="Threads" shortcut="goHome">
          <Link
            to="/"
            aria-label="Threads"
            aria-current={settings ? undefined : "page"}
            className={railPlaceClass}
          >
            <Icon icon={FoldersIcon} size={20} active={!settings} />
          </Link>
        </Tip>
        <span className="flex-1" />
        <UpdateButton />
        <Tip label="Settings" shortcut="settings">
          <Link
            to="/settings/remote"
            aria-label="Settings"
            aria-current={settings && !profile ? "page" : undefined}
            className={railPlaceClass}
          >
            <Icon icon={GearSixIcon} size={20} active={settings && !profile} />
          </Link>
        </Tip>
        <Tip label={name.trim() || "Profile"}>
          <Link
            to="/settings/profile"
            aria-label="Profile"
            aria-current={profile ? "page" : undefined}
            className={railPlaceClass}
          >
            <ProfileAvatar name={name} className="size-7 text-2xs" iconSize={14} />
          </Link>
        </Tip>
      </TooltipSide>
    </nav>
  );
}
