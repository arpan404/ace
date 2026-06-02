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
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

const PERMISSION_META: Record<
  DesktopBrowserPermission,
  {
    description: string;
    icon: ComponentType<{ className?: string }>;
    label: string;
  }
> = {
  camera: { label: "Camera", description: "Use this computer's camera.", icon: CameraIcon },
  microphone: {
    label: "Microphone",
    description: "Use this computer's microphone.",
    icon: MicIcon,
  },
  media: {
    label: "Camera and microphone",
    description: "Use camera and audio together.",
    icon: CameraIcon,
  },
  clipboard: {
    label: "Clipboard",
    description: "Read text or images copied on this computer.",
    icon: ClipboardIcon,
  },
  displayCapture: {
    label: "Screen sharing",
    description: "Capture a window, screen, or browser tab.",
    icon: ScreenShareIcon,
  },
  fileSystem: {
    label: "File access",
    description: "Open local files selected from the browser.",
    icon: FolderIcon,
  },
  fullscreen: {
    label: "Fullscreen",
    description: "Fill the display with this page.",
    icon: ScreenShareIcon,
  },
  geolocation: {
    label: "Location",
    description: "Use approximate device location.",
    icon: MapPinIcon,
  },
  hid: {
    label: "Connected devices",
    description: "Access keyboards, controllers, and other HID devices.",
    icon: KeyRoundIcon,
  },
  idleDetection: {
    label: "Idle state",
    description: "Know whether this computer is active or idle.",
    icon: WorkflowIcon,
  },
  keyboardLock: {
    label: "Keyboard shortcuts",
    description: "Capture keys normally reserved by the browser.",
    icon: WorkflowIcon,
  },
  midi: {
    label: "MIDI devices",
    description: "Access connected music devices.",
    icon: WorkflowIcon,
  },
  notifications: {
    label: "Notifications",
    description: "Show alerts from this site.",
    icon: BellIcon,
  },
  openExternal: {
    label: "External apps",
    description: "Open links in apps outside the browser.",
    icon: WorkflowIcon,
  },
  pointerLock: {
    label: "Pointer lock",
    description: "Capture mouse movement for games or 3D tools.",
    icon: WorkflowIcon,
  },
  serial: {
    label: "Serial ports",
    description: "Connect to hardware over serial.",
    icon: WorkflowIcon,
  },
  speakerSelection: {
    label: "Audio output",
    description: "Choose which speaker or output device to use.",
    icon: WorkflowIcon,
  },
  storageAccess: {
    label: "Embedded site data",
    description: "Let embedded content use its own cookies.",
    icon: DatabaseIcon,
  },
  topLevelStorageAccess: {
    label: "Top-level site data",
    description: "Use stored data after opening as the main page.",
    icon: DatabaseIcon,
  },
  usb: { label: "USB devices", description: "Connect to USB hardware.", icon: UsbIcon },
  windowManagement: {
    label: "Window placement",
    description: "See and arrange windows across screens.",
    icon: ScreenShareIcon,
  },
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
  "windowManagement",
];

const SETTING_LABELS: Record<DesktopBrowserPermissionSetting, string> = {
  ask: "Ask",
  allow: "Allow",
  block: "Block",
};

const PERMISSION_OPTIONS = ["ask", "allow", "block"] as const;

function formatCookieSummary(count: number | undefined): string {
  const normalizedCount = count ?? 0;
  if (normalizedCount === 0) {
    return "No cookies stored";
  }
  if (normalizedCount === 1) {
    return "1 cookie stored";
  }
  return `${normalizedCount} cookies stored`;
}

function formatSiteDataSummary(siteInfo: DesktopBrowserSiteInfo | null): string {
  if (!siteInfo) {
    return "Loading site data";
  }
  if (!siteInfo.storageOrigin && siteInfo.cookieCount === 0) {
    return "Nothing saved by this site";
  }
  return "Saved data can be cleared here";
}

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
  const api = useMemo(() => ensureNativeApi(), []);

  const refresh = useCallback(async () => {
    if (!url || !open) {
      setSiteInfo(null);
      return;
    }
    try {
      setSiteInfo(await api.browser.getSiteInfo(url));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Site controls unavailable.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
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
      <DialogPopup className="w-[min(34rem,calc(100vw-1rem))] max-w-none overflow-hidden border-border/55 bg-background/95 p-0 supports-[backdrop-filter]:bg-background/88">
        <DialogHeader className="gap-2 border-b border-border/35 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/45 bg-card/45 text-muted-foreground">
              <ShieldCheckIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate text-[0.98rem]">Site controls</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-xs font-normal">
                {hostLabel}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogPanel className="max-h-[min(68dvh,34rem)] px-4 py-4 sm:px-5" scrollFade>
          <div className="space-y-3.5">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-[var(--control-radius)] border border-border/35 bg-card/30 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground/85">
                  <DatabaseIcon className="size-3.5 text-muted-foreground/55" />
                  Cookies
                </div>
                <div className="mt-1 text-xs text-muted-foreground/65">
                  {formatCookieSummary(siteInfo?.cookieCount)}
                </div>
              </div>
              <div className="rounded-[var(--control-radius)] border border-border/35 bg-card/30 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground/85">
                  <DatabaseIcon className="size-3.5 text-muted-foreground/55" />
                  Site data
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground/65">
                  {formatSiteDataSummary(siteInfo)}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-[var(--control-radius)] border border-border/35 bg-card/20">
              {VISIBLE_PERMISSIONS.map((permission) => {
                const currentSetting = permissionsByName.get(permission) ?? "ask";
                const meta = PERMISSION_META[permission];
                const PermissionIcon = meta.icon;
                return (
                  <div
                    key={permission}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/25 px-3 py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[calc(var(--control-radius)-2px)] border border-border/25 bg-background/45 text-muted-foreground/65">
                        <PermissionIcon className="size-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-foreground/90">
                          {meta.label}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/60">
                          {meta.description}
                        </span>
                      </span>
                    </div>

                    <div className="inline-flex rounded-[var(--control-radius)] border border-border/35 bg-background/55 p-0.5">
                      {PERMISSION_OPTIONS.map((setting) => (
                        <button
                          key={setting}
                          type="button"
                          className={cn(
                            "h-6 min-w-11 rounded-[calc(var(--control-radius)-3px)] px-2 text-[11px] font-medium transition-colors",
                            currentSetting === setting
                              ? setting === "allow"
                                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                : setting === "block"
                                  ? "bg-destructive/10 text-destructive"
                                  : "bg-foreground/[0.08] text-foreground"
                              : "text-muted-foreground/65 hover:bg-foreground/[0.04] hover:text-foreground",
                          )}
                          onClick={() => {
                            void setPermission(permission, setting);
                          }}
                          aria-pressed={currentSetting === setting}
                        >
                          {SETTING_LABELS[setting]}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </DialogPanel>

        <DialogFooter className="border-t border-border/35 bg-card/20 px-4 py-3 sm:px-5">
          <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
            <RotateCcwIcon className="size-3" />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={resetPermissions}
            disabled={!url}
          >
            <RotateCcwIcon className="size-3" />
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={clearSiteData}
            disabled={!url}
          >
            <Trash2Icon className="size-3" />
            Clear data
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
