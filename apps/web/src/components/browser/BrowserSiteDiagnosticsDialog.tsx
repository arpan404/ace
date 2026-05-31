import type {
  DesktopBrowserDownload,
  DesktopBrowserDownloadAction,
  DesktopBrowserPermission,
  DesktopBrowserPermissionSetting,
  DesktopBrowserSiteInfo,
} from "@ace/contracts";
import {
  ExternalLinkIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
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
import { cn } from "~/lib/utils";

const PERMISSION_LABELS: Record<DesktopBrowserPermission, string> = {
  camera: "Camera",
  microphone: "Microphone",
  media: "Camera and mic",
  clipboard: "Clipboard",
  displayCapture: "Screen",
  fileSystem: "Files",
  fullscreen: "Fullscreen",
  geolocation: "Location",
  hid: "HID",
  idleDetection: "Idle",
  keyboardLock: "Keyboard",
  midi: "MIDI",
  notifications: "Notifications",
  openExternal: "External links",
  pointerLock: "Pointer lock",
  serial: "Serial",
  speakerSelection: "Speaker",
  storageAccess: "Storage",
  topLevelStorageAccess: "Top storage",
  usb: "USB",
  windowManagement: "Windows",
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
  readonly onOpenExternal: () => void;
}) {
  const { open, url, onOpenChange, onOpenExternal } = props;
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
      <DialogPopup className="w-[min(42rem,calc(100vw-1.5rem))] max-w-none overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                <ShieldCheckIcon className="size-4 text-primary" />
                Browser site panel
              </DialogTitle>
              <DialogDescription className="mt-1 truncate">
                {siteInfo?.origin ?? url ?? "No active site"}
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onOpenExternal}
              disabled={!url}
            >
              <ExternalLinkIcon className="size-3.5" />
              Default browser
            </Button>
          </div>
        </DialogHeader>

        <DialogPanel className="max-h-[min(70dvh,42rem)] px-5 py-4" scrollFade>
          <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-foreground">Permissions</h3>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={resetPermissions}
                  disabled={!url}
                >
                  <RotateCcwIcon className="size-3.5" />
                  Reset
                </Button>
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                {VISIBLE_PERMISSIONS.map((permission) => {
                  const currentSetting = permissionsByName.get(permission) ?? "ask";
                  return (
                    <div
                      key={permission}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 px-3 py-2.5 last:border-b-0"
                    >
                      <span className="truncate text-sm text-foreground/88">
                        {PERMISSION_LABELS[permission]}
                      </span>
                      <div className="inline-flex rounded-md border border-border bg-background p-0.5">
                        {(["ask", "allow", "block"] as const).map((setting) => (
                          <button
                            key={setting}
                            type="button"
                            className={cn(
                              "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                              currentSetting === setting
                                ? setting === "allow"
                                  ? "bg-emerald-500/14 text-emerald-600 dark:text-emerald-300"
                                  : setting === "block"
                                    ? "bg-destructive/12 text-destructive"
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
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-foreground">Site data</h3>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={clearSiteData}
                  disabled={!url}
                >
                  <Trash2Icon className="size-3.5" />
                  Clear
                </Button>
              </div>
              <div className="rounded-lg border border-border px-3 py-3">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Cookies</dt>
                  <dd className="text-right font-medium">{siteInfo?.cookieCount ?? 0}</dd>
                  <dt className="text-muted-foreground">Downloads</dt>
                  <dd className="text-right font-medium">{downloads.length}</dd>
                  <dt className="text-muted-foreground">Active</dt>
                  <dd className="text-right font-medium">{siteInfo?.activeDownloads ?? 0}</dd>
                </dl>
                <p className="mt-3 line-clamp-3 break-all border-t border-border/70 pt-3 font-mono text-[10px] leading-4 text-muted-foreground">
                  {siteInfo?.userAgent ?? (loading ? "Loading..." : "Unavailable")}
                </p>
              </div>
            </section>
          </div>

          <section className="mt-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">Downloads</h3>
              <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
                <RotateCcwIcon className="size-3.5" />
                Refresh
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              {downloads.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No downloads in this browser session.
                </div>
              ) : (
                downloads.slice(0, 8).map((download) => (
                  <div
                    key={download.id}
                    className="grid gap-2 border-b border-border/70 px-3 py-3 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {download.filename}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {download.state} · {formatDownloadProgress(download)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {download.state === "progressing" ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            onClick={() =>
                              void controlDownload(download, download.paused ? "resume" : "pause")
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
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
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
        </DialogPanel>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
