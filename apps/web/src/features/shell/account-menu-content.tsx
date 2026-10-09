import {
  ArchiveIcon,
  ChartBarIcon,
  InfoIcon,
  KeyboardIcon,
  MoonIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { Icon } from "@/components/icon.tsx";
import { menuViews } from "./views.ts";
import { menuLabel } from "@/components/ui/menu-styles.ts";
import { cn } from "@/lib/cn.ts";
import { useProfileName } from "@/lib/profile.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

const schemes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** The desktop app's version, from its preload bridge; a browser tab has none to show. */
function desktopVersion(): string | undefined {
  const ace: unknown = Reflect.get(globalThis, "ace");
  if (typeof ace !== "object" || ace === null || !("electron" in ace) || !("version" in ace))
    return undefined;
  return typeof ace.version === "string" ? ace.version : undefined;
}

/**
 * The profile's menu, loaded after the first paint (`SidebarMenu`): the person and the app,
 * never the daemon (that is the sidebar's "ace ▾"). Who this is, the light or dark scheme,
 * shortcuts, usage and accounts (its only way in), and which ace this is. Settings is the gear
 * beside the profile, so it isn't repeated here.
 */
export function AccountMenuContent() {
  const [name] = useProfileName();
  const navigate = useNavigate();
  const { appearance, update } = useTheme();
  const scheme = schemes.some((option) => option.value === appearance.theme)
    ? appearance.theme
    : undefined;
  const version = desktopVersion();
  return (
    <MenuContent side="top" align="start" className="min-w-(--anchor-width)">
      <div className="flex items-center gap-2 truncate px-2.5 py-1.5 text-ui font-medium text-foreground">
        <UserIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
      <MenuSub>
        <MenuSubTrigger icon={<MoonIcon aria-hidden />}>Appearance</MenuSubTrigger>
        <MenuContent side="right" align="start" sideOffset={4} className="min-w-[160px]">
          <MenuRadioGroup
            {...(scheme ? { value: scheme } : {})}
            onValueChange={(value: string) => update({ theme: value })}
          >
            {schemes.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </MenuSub>
      <MenuItem
        icon={<KeyboardIcon aria-hidden />}
        onClick={() => void navigate({ to: "/settings/keyboard" })}
      >
        Keyboard shortcuts
      </MenuItem>
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
