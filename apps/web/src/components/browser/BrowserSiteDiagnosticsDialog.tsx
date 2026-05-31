import type {
  DesktopBrowserDownload,
  DesktopBrowserDownloadAction,
  DesktopBrowserPermission,
  DesktopBrowserPermissionSetting,
  DesktopBrowserSiteInfo,
} from "@ace/contracts";
import {
  BellIcon,
  CameraIcon,
  ClipboardIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  HardDriveDownloadIcon,
  KeyRoundIcon,
  LaptopMinimalCheckIcon,
  MapPinIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  ScanFaceIcon,
  ScreenShareIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundCheckIcon,
  UsbIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
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
import { cn } from "~/lib/utils";

const PERMISSION_META: Record<
  DesktopBrowserPermission,
  {
    description: string;
    icon: ComponentType<{ className?: string }>;
    label: string;
  }
> = {
  camera: {
    label: "Camera",
    description: "Allow video capture and camera prompts.",
    icon: CameraIcon,
  },
  microphone: {
    label: "Microphone",
    description: "Allow audio capture and voice prompts.",
    icon: MicIcon,
  },
  media: {
    label: "Camera and mic",
    description: "Allow combined media capture requests.",
    icon: ScanFaceIcon,
  },
  clipboard: {
    label: "Clipboard",
    description: "Allow reading and writing clipboard data.",
    icon: ClipboardIcon,
  },
  displayCapture: {
    label: "Screen",
    description: "Allow screen share and display capture.",
    icon: ScreenShareIcon,
  },
  fileSystem: {
    label: "Files",
    description: "Allow file and folder access requests.",
    icon: FolderIcon,
  },
  fullscreen: {
    label: "Fullscreen",
    description: "Allow fullscreen takeover requests.",
    icon: LaptopMinimalCheckIcon,
  },
  geolocation: {
    label: "Location",
    description: "Allow location lookups for this site.",
    icon: MapPinIcon,
  },
  hid: {
    label: "HID",
    description: "Allow hardware token and HID device access.",
    icon: KeyRoundIcon,
  },
  idleDetection: {
    label: "Idle",
    description: "Allow idle detection signals.",
    icon: UserRoundCheckIcon,
  },
  keyboardLock: {
    label: "Keyboard",
    description: "Allow keyboard lock shortcuts.",
    icon: WorkflowIcon,
  },
  midi: {
    label: "MIDI",
    description: "Allow MIDI device access.",
    icon: WorkflowIcon,
  },
  notifications: {
    label: "Notifications",
    description: "Allow system notification prompts.",
    icon: BellIcon,
  },
  openExternal: {
    label: "External links",
    description: "Allow opening external applications.",
    icon: ExternalLinkIcon,
  },
  pointerLock: {
    label: "Pointer lock",
    description: "Allow pointer lock input.",
    icon: WorkflowIcon,
  },
  serial: {
    label: "Serial",
    description: "Allow serial port access.",
    icon: WorkflowIcon,
  },
  speakerSelection: {
    label: "Speaker",
    description: "Allow output device selection.",
    icon: WorkflowIcon,
  },
  storageAccess: {
    label: "Storage",
    description: "Allow storage access across contexts.",
    icon: DatabaseIcon,
  },
  topLevelStorageAccess: {
    label: "Top storage",
    description: "Allow top-level storage access.",
    icon: DatabaseIcon,
  },
  usb: {
    label: "USB",
    description: "Allow USB device access.",
    icon: UsbIcon,
  },
  windowManagement: {
    label: "Windows",
    description: "Allow window-management requests.",
    icon: GlobeIcon,
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
  "storageAccess",
  "windowManagement",
];

const SETTING_LABELS: Record<DesktopBrowserPermissionSetting, string> = {
  ask: "Ask",
  allow: "Allow",
  block: "Block",
};

const PERMISSION_OPTIONS = ["ask", "allow", "block"] as const;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"] as const;
  let unitIndex = 0;
  let nextValue = value;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  return `${nextValue >= 10 || unitIndex === 0 ? nextValue.toFixed(0) : nextValue.toFixed(1)} ${units[unitIndex]}`;
}

function formatDownloadProgress(download: DesktopBrowserDownload): string {
  if (download.totalBytes > 0) {
    return `${formatBytes(download.receivedBytes)} / ${formatBytes(download.totalBytes)}`;
  }
  return formatBytes(download.receivedBytes);
}

function formatDownloadStateLabel(state: DesktopBrowserDownload["state"]): string {
  switch (state) {
    case "progressing":
      return "In progress";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      return state;
  }
}

function isTerminalDownload(download: DesktopBrowserDownload): boolean {
  return (
    download.state === "completed" ||
    download.state === "cancelled" ||
    download.state === "interrupted"
  );
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
        title: "Site info unavailable.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setLoading(false);
    }
  }, [api, open, url]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) {
      return;
    }
    return api.browser.onDownloadEvent(() => {
      void refresh();
    });
  }, [api, open, refresh]);

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

  const controlDownload = useCallback(
    async (download: DesktopBrowserDownload, action: DesktopBrowserDownloadAction) => {
      const ok = await api.browser.controlDownload({ id: download.id, action });
      if (!ok) {
        toastManager.add({ type: "error", title: "Download action failed." });
      }
      await refresh();
    },
    [api, refresh],
  );

  const downloads = siteInfo?.downloads ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-[min(56rem,calc(100vw-1.5rem))] max-w-none overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--popover)_94%,transparent),color-mix(in_srgb,var(--muted)_42%,transparent))] px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4 pr-10">
            <div className="min-w-0 space-y-2">
              <DialogTitle className="flex items-center gap-2 text-[1.1rem]">
                <span className="inline-flex size-8 items-center justify-center rounded-xl border border-primary/18 bg-primary/[0.08] text-primary">
                  <ShieldCheckIcon className="size-4" />
                </span>
                Site controls
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2 text-sm">
                <span className="truncate font-medium text-foreground/82">
                  {siteInfo?.origin ?? url ?? "No active site"}
                </span>
                <span className="hidden text-muted-foreground/70 sm:inline">·</span>
                <span className="text-muted-foreground">
                  Permissions, storage, and downloads for this browser session.
                </span>
              </DialogDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="rounded-full border border-border/70 bg-background/72 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {siteInfo?.cookieCount ?? 0} cookies
              </div>
              <div className="rounded-full border border-border/70 bg-background/72 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {downloads.length} downloads
              </div>
              <div className="rounded-full border border-border/70 bg-background/72 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {siteInfo?.activeDownloads ?? 0} active
              </div>
            </div>
          </div>
        </DialogHeader>

        <DialogPanel className="max-h-[min(76dvh,44rem)] px-5 py-5 sm:px-6" scrollFade>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_19rem]">
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Permissions</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Apply per-site rules without leaving the browser.
                  </p>
                </div>
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
              </div>

              <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/[0.18]">
                {VISIBLE_PERMISSIONS.map((permission) => {
                  const currentSetting = permissionsByName.get(permission) ?? "ask";
                  const meta = PERMISSION_META[permission];
                  const PermissionIcon = meta.icon;
                  return (
                    <div
                      key={permission}
                      className="grid gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/84 text-muted-foreground">
                          <PermissionIcon className="size-3.5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{meta.label}</p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {meta.description}
                          </p>
                        </div>
                      </div>

                      <div className="inline-flex w-fit rounded-xl border border-border/70 bg-background/88 p-1 shadow-sm">
                        {PERMISSION_OPTIONS.map((setting) => (
                          <button
                            key={setting}
                            type="button"
                            className={cn(
                              "min-w-14 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                              currentSetting === setting
                                ? setting === "allow"
                                  ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                  : setting === "block"
                                    ? "bg-destructive/10 text-destructive"
                                    : "bg-muted text-foreground"
                                : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
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
            </section>

            <aside className="space-y-4 xl:sticky xl:top-0">
              <section className="rounded-2xl border border-border/70 bg-background/72 p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Session snapshot</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      A quick read on local site state.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void refresh()}
                    disabled={loading}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    Refresh
                  </Button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-border/70 bg-muted/[0.22] px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      Cookies
                    </p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {siteInfo?.cookieCount ?? 0}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-muted/[0.22] px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      Total
                    </p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {downloads.length}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-muted/[0.22] px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      Active
                    </p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {siteInfo?.activeDownloads ?? 0}
                    </p>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-border/70 bg-muted/[0.18] px-3 py-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground/78">
                    <GlobeIcon className="size-3.5 text-muted-foreground" />
                    User agent
                  </div>
                  <p className="mt-2 line-clamp-4 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                    {siteInfo?.userAgent ?? (loading ? "Loading..." : "Unavailable")}
                  </p>
                </div>

                <div className="mt-4 grid gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={clearSiteData}
                    disabled={!url}
                    className="justify-start"
                  >
                    <Trash2Icon className="size-3.5" />
                    Clear site data
                  </Button>
                </div>
              </section>

              <section className="rounded-2xl border border-border/70 bg-background/72 p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex size-8 items-center justify-center rounded-xl border border-border/70 bg-muted/[0.22] text-muted-foreground">
                      <HardDriveDownloadIcon className="size-3.5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">Downloads</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Recent items in this browser session.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {downloads.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/70 bg-muted/[0.16] px-4 py-6 text-center">
                      <p className="text-sm font-medium text-foreground/78">No downloads yet</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Files downloaded from this site will appear here.
                      </p>
                    </div>
                  ) : (
                    downloads.slice(0, 6).map((download) => (
                      <div
                        key={download.id}
                        className="rounded-xl border border-border/70 bg-muted/[0.18] px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {download.filename}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatDownloadStateLabel(download.state)} ·{" "}
                              {formatDownloadProgress(download)}
                            </p>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {download.state === "progressing" ? (
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                onClick={() =>
                                  void controlDownload(
                                    download,
                                    download.paused ? "resume" : "pause",
                                  )
                                }
                                aria-label={download.paused ? "Resume download" : "Pause download"}
                              >
                                {download.paused ? (
                                  <PlayIcon className="size-3.5" />
                                ) : (
                                  <PauseIcon className="size-3.5" />
                                )}
                              </Button>
                            ) : null}
                            {!isTerminalDownload(download) ? (
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                onClick={() => void controlDownload(download, "cancel")}
                                aria-label="Cancel download"
                              >
                                <XIcon className="size-3.5" />
                              </Button>
                            ) : null}
                            {download.savePath ? (
                              <>
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  onClick={() => void controlDownload(download, "reveal")}
                                  aria-label="Reveal download"
                                >
                                  <FolderOpenIcon className="size-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  onClick={() => void controlDownload(download, "open")}
                                  aria-label="Open download"
                                >
                                  <ExternalLinkIcon className="size-3.5" />
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>

                        {download.totalBytes > 0 ? (
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{
                                width: `${Math.max(0, Math.min(100, download.percentComplete))}%`,
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </aside>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
