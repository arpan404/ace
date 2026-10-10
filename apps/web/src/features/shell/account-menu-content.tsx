import { DaemonMenuItems } from "./daemon-menu-content.tsx";
import {
  ArchiveIcon,
  ChartBarIcon,
  InfoIcon,
  KeyboardIcon,
  PlugsIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { Icon } from "@/components/icon.tsx";
import { menuViews } from "./views.ts";
import { menuLabel } from "@/components/ui/menu-styles.ts";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProfileName } from "@/lib/profile.ts";

/** The desktop app's version, from its preload bridge; a browser tab has none to show. */
function desktopVersion(): string | undefined {
  const ace: unknown = Reflect.get(globalThis, "ace");
  if (typeof ace !== "object" || ace === null || !("electron" in ace) || !("version" in ace))
    return undefined;
  return typeof ace.version === "string" ? ace.version : undefined;
}

/**
 * The profile's menu, loaded after the first paint (`SidebarMenu`): the person and the app,
 * with connection actions in their own submenu, usage and accounts, and the desktop version.
 * Settings is the gear
 * beside the profile, so it isn't repeated here.
 */
export function AccountMenuContent() {
  const layout = useLayout();
  const [name] = useProfileName();
  const navigate = useNavigate();
  const version = desktopVersion();
  return (
    <MenuContent side="top" align="start" className="min-w-(--anchor-width)">
      <div className="flex items-center gap-2 truncate px-2.5 py-1.5 text-ui text-muted-foreground">
        <span className="truncate">{name || "You"}</span>
      </div>
      <MenuSeparator />
      {menuViews.map((view) => (
        <MenuItem
          key={view.id}
          icon={<Icon icon={view.icon} />}
          onClick={() => void navigate({ to: view.to })}
        >
          {view.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={<ChartBarIcon aria-hidden />}
        onClick={() => void navigate({ to: "/accounts" })}
      >
        Usage & accounts
      </MenuItem>
      <MenuItem
        icon={<ArchiveIcon aria-hidden />}
        onClick={() => void navigate({ to: "/archived" })}
      >
        Archived threads
      </MenuItem>
      <MenuItem
        icon={<KeyboardIcon aria-hidden />}
        shortcut="shortcuts"
        onClick={() => layout.setShortcutsOpen(true)}
      >
        Keyboard shortcuts
      </MenuItem>
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger icon={<PlugsIcon aria-hidden />}>Connection</MenuSubTrigger>
        <MenuContent aria-label="Connection" side="right" align="start" className="max-w-[300px]">
          <DaemonMenuItems />
        </MenuContent>
      </MenuSub>
      {version && (
        <>
          <MenuSeparator />
          <div className={cn(menuLabel, "flex items-center gap-2 pb-1.5")}>
            <InfoIcon aria-hidden className="size-3.5" />
            ace {version}
          </div>
        </>
      )}
    </MenuContent>
  );
}
