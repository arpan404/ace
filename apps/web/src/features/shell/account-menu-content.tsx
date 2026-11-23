import { DaemonMenuItems } from "./daemon-menu-content.tsx";
import { SpaceMenuItems } from "./space-menu-items.tsx";
import { ArchiveIcon, InfoIcon, KeyboardIcon, PlugsIcon } from "@ace/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { useState } from "react";
import { openRelease, useDesktopUpdate } from "@/boot/desktop-updates.ts";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import {
  useAccountPicture,
  useAceAccount,
  useAceAccountStore,
} from "@/features/ace-account/index.ts";
import { accountUpdateRow, updateAction } from "./update-status.ts";
import { UpdateRestartDialog } from "./update-restart-dialog.tsx";
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
 * The profile's menu, loaded after the first paint (`SidebarMenu`): the person first (their
 * avatar, name and ace account, opening Settings › Profile), then the app,
 * with connection actions in their own submenu, and the desktop version. Settings, Usage,
 * Automations and Skills are places in the rail above it, so they aren't repeated here.
 */
export function AccountMenuContent() {
  const layout = useLayout();
  const [name] = useProfileName();
  const { session } = useAceAccount();
  const accounts = useAceAccountStore();
  const picture = useAccountPicture();
  const navigate = useNavigate();
  const update = useDesktopUpdate();
  const status = update.status;
  const version = status?.currentVersion || desktopVersion();
  const [checked, setChecked] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<number | null | undefined>(undefined);
  const row = status ? accountUpdateRow(status, checked) : undefined;
  const action = status ? updateAction(status) : "none";
  const act = () => {
    if (action === "check") {
      setCheckFailed(false);
      void update.check().then((next) => {
        setChecked(true);
        setCheckFailed(!next);
      });
    } else if (action === "download") update.download();
    else if (action === "open-release" && status?.releaseUrl) openRelease(status.releaseUrl);
    else if (action === "install") {
      setBusy(undefined);
      setConfirming(true);
      void update.busy().then((count) => setBusy(count ?? null));
    }
  };
  const shown = session?.account.name || name.trim();
  return (
    <>
      <MenuContent side="right" align="end" className="min-w-64">
        <MenuItem
          icon={
            <ProfileAvatar
              name={shown}
              picture={picture}
              className="size-9 text-sm"
              iconSize={16}
            />
          }
          className="h-auto gap-3 py-2"
          onClick={() => void navigate({ to: "/settings/profile" })}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{shown || "You"}</span>
            <span className="truncate text-xs text-muted-foreground">
              {session?.account.email ?? (accounts ? "Not signed in" : "Your profile")}
            </span>
          </span>
        </MenuItem>
        <SpaceMenuItems />
        <MenuSeparator />
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
            <MenuItem
              icon={<InfoIcon aria-hidden />}
              reason={`ace ${version}`}
              disabled={action === "none"}
              closeOnClick={action === "install" || action === "open-release"}
              onClick={act}
            >
              {row?.label ?? "Check for updates"}
            </MenuItem>
            <div role="status" className="empty:hidden px-2.5 pb-1 text-xs text-muted-foreground">
              {checkFailed ? "Couldn't check for updates. Try again." : row?.detail}
            </div>
          </>
        )}
      </MenuContent>
      {confirming && (
        <UpdateRestartDialog
          open={confirming}
          busy={busy}
          onOpenChange={setConfirming}
          onInstall={update.install}
        />
      )}
    </>
  );
}
