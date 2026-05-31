import type {
  DesktopBrowserPermission,
  DesktopBrowserPermissionSetting,
  DesktopBrowserSiteInfo,
} from "@ace/contracts";
import {
  BellIcon,
  CameraIcon,
  ClipboardIcon,
  DatabaseIcon,
  FolderIcon,
  GlobeIcon,
  KeyRoundIcon,
  MapPinIcon,
  MicIcon,
  RotateCcwIcon,
  ScreenShareIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UsbIcon,
  WorkflowIcon,
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

const PERMISSION_META: Record<
  DesktopBrowserPermission,
  {
    icon: ComponentType<{ className?: string }>;
    label: string;
  }
> = {
  camera: { label: "Camera", icon: CameraIcon },
  microphone: { label: "Microphone", icon: MicIcon },
  media: { label: "Camera and mic", icon: CameraIcon },
  clipboard: { label: "Clipboard", icon: ClipboardIcon },
  displayCapture: { label: "Screen", icon: ScreenShareIcon },
  fileSystem: { label: "Files", icon: FolderIcon },
  fullscreen: { label: "Fullscreen", icon: GlobeIcon },
  geolocation: { label: "Location", icon: MapPinIcon },
  hid: { label: "HID", icon: KeyRoundIcon },
  idleDetection: { label: "Idle", icon: WorkflowIcon },
  keyboardLock: { label: "Keyboard", icon: WorkflowIcon },
  midi: { label: "MIDI", icon: WorkflowIcon },
  notifications: { label: "Notifications", icon: BellIcon },
  openExternal: { label: "External links", icon: GlobeIcon },
  pointerLock: { label: "Pointer lock", icon: WorkflowIcon },
  serial: { label: "Serial", icon: WorkflowIcon },
  speakerSelection: { label: "Speaker", icon: WorkflowIcon },
  storageAccess: { label: "Storage", icon: DatabaseIcon },
  topLevelStorageAccess: { label: "Top storage", icon: DatabaseIcon },
  usb: { label: "USB", icon: UsbIcon },
  windowManagement: { label: "Windows", icon: GlobeIcon },
};

const VISIBLE_PERMISSIONS: readonly DesktopBrowserPermission[] = [
  "camera",
  "microphone",
  "clipboard",
  "notifications",
  "geolocation",
  "displayCapture",
  "fileSystem",
  "hid",
  "usb",
  "serial",
  "storageAccess",
  "windowManagement",
];

const SETTING_LABELS: Record<DesktopBrowserPermissionSetting, string> = {
  ask: "Ask",
  allow: "Allow",
  block: "Block",
};

const PERMISSION_OPTIONS = ["ask", "allow", "block"] as const;

function resolveDialogHostLabel(input: {
  siteInfo: DesktopBrowserSiteInfo | null;
  url: string | null;
}): string {
  if (input.siteInfo?.origin) {
    return input.siteInfo.origin;
  }
  if (!input.url) {
    return "No active site";
  }
  try {
    return new URL(input.url).host.replace(/^www\./iu, "");
  } catch {
    return input.url;
  }
}

export function BrowserSiteDiagnosticsDialog(props: {
  readonly open: boolean;
  readonly url: string | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { open, url, onOpenChange } = props;
  const [siteInfo, setSiteInfo] = useState<DesktopBrowserSiteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const api = useMemo(() => ensureNativeApi(), []);

  const refresh = useCallback(async () => {
    if (!url || !open) {
      setSiteInfo(null);
      return;
    }
    setLoading(true);
    try {
      setSiteInfo(await api.browser.getSiteInfo(url));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Site controls unavailable.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setLoading(false);
    }
  }, [api, open, url]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const permissionsByName = useMemo(() => {
    const next = new Map<DesktopBrowserPermission, DesktopBrowserPermissionSetting>();
    for (const permission of siteInfo?.permissions ?? []) {
      next.set(permission.permission, permission.setting);
    }
    return next;
  }, [siteInfo?.permissions]);

  const setPermission = useCallback(
    async (permission: DesktopBrowserPermission, setting: DesktopBrowserPermissionSetting) => {
      if (!url) {
        return;
      }
      const updated = await api.browser.setSitePermission({ permission, setting, url });
      if (!updated) {
        toastManager.add({ type: "error", title: "Permission update failed." });
        return;
      }
      await refresh();
    },
    [api, refresh, url],
  );

  const clearSiteData = useCallback(async () => {
    if (!url) {
      return;
    }
    const cleared = await api.browser.clearSiteData(url);
    toastManager.add({
      type: cleared ? "success" : "error",
      title: cleared ? "Site data cleared." : "Site data was not cleared.",
    });
    await refresh();
  }, [api, refresh, url]);

  const resetPermissions = useCallback(async () => {
    if (!url) {
      return;
    }
    const reset = await api.browser.resetSitePermissions(url);
    toastManager.add({
      type: reset ? "success" : "error",
      title: reset ? "Permissions reset." : "Permissions were not reset.",
    });
    await refresh();
  }, [api, refresh, url]);

  const hostLabel = resolveDialogHostLabel({ siteInfo, url });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-[min(32rem,calc(100vw-1rem))] max-w-none overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-4 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-[0.98rem]">
            <span className="inline-flex size-7 items-center justify-center rounded-lg border border-border/70 bg-muted/28 text-primary">
              <ShieldCheckIcon className="size-3.5" />
            </span>
            Site controls
          </DialogTitle>
          <DialogDescription className="truncate text-xs">{hostLabel}</DialogDescription>
        </DialogHeader>

        <DialogPanel className="max-h-[min(70dvh,34rem)] px-4 py-4" scrollFade>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/70 bg-muted/[0.16] px-3 py-2">
                <div className="text-[11px] font-medium text-muted-foreground">Cookies</div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {siteInfo?.cookieCount ?? 0}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/[0.16] px-3 py-2">
                <div className="text-[11px] font-medium text-muted-foreground">Storage</div>
                <div className="mt-1 truncate text-sm font-semibold text-foreground">
                  {siteInfo?.storageOrigin ? "Stored" : "None"}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-border/70">
              {VISIBLE_PERMISSIONS.map((permission) => {
                const currentSetting = permissionsByName.get(permission) ?? "ask";
                const meta = PERMISSION_META[permission];
                const PermissionIcon = meta.icon;
                return (
                  <div
                    key={permission}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                        <PermissionIcon className="size-3.5" />
                      </span>
                      <span className="truncate text-sm font-medium text-foreground">
                        {meta.label}
                      </span>
                    </div>

                    <div className="inline-flex rounded-md border border-border/70 bg-background p-0.5">
                      {PERMISSION_OPTIONS.map((setting) => (
                        <button
                          key={setting}
                          type="button"
                          className={cn(
                            "h-6 min-w-11 rounded px-2 text-[11px] font-medium transition-colors",
                            currentSetting === setting
                              ? setting === "allow"
                                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                : setting === "block"
                                  ? "bg-destructive/10 text-destructive"
                                  : "bg-muted text-foreground"
                              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                          )}
                          onClick={() => {
                            void setPermission(permission, setting);
                          }}
                        >
                          {SETTING_LABELS[setting]}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/[0.12] px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                <GlobeIcon className="size-3.5 text-muted-foreground" />
                User agent
              </div>
              <p className="mt-2 line-clamp-2 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                {siteInfo?.userAgent ?? (loading ? "Loading..." : "Unavailable")}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-3">
              <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
                <RotateCcwIcon className="size-3.5" />
                Refresh
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={resetPermissions}
                disabled={!url}
              >
                <RotateCcwIcon className="size-3.5" />
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={clearSiteData}
                disabled={!url}
              >
                <Trash2Icon className="size-3.5" />
                Clear data
              </Button>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
