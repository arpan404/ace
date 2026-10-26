import { revealWords } from "@/lib/folder-actions.ts";
import {
  CopyIcon,
  DeviceMobileIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileArchiveIcon,
  FileIcon,
  FolderOpenIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { downloadStateLabels } from "@ace/ui-core";
import { useLocalReveal } from "@/lib/local-reveal.ts";
import { formatBytes } from "@/components/format-bytes.ts";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { BrowserDownloadView } from "../sources.ts";
import { toolbarButton } from "./page-toolbar.tsx";
import { useSaveDownload } from "./use-save-download.ts";

const states: Record<BrowserDownloadView["state"], string> = downloadStateLabels;

function DownloadRow(props: {
  download: BrowserDownloadView;
  reveal: ((path: string) => Promise<void>) | undefined;
  /** Fetch it to this device; absent where the file is already on this computer. */
  save: ((download: BrowserDownloadView) => void) | undefined;
  /** How far a save to this device has come, 0 to 1, while one runs. */
  saving: number | undefined;
}) {
  const toast = useToast();
  const { download, reveal, saving } = props;
  const path = download.state === "complete" ? download.path : undefined;
  const save = download.state === "complete" ? props.save : undefined;
  const risky = download.flags.includes("executable");
  return (
    <li className="flex min-h-12 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/5 text-muted-foreground">
        <Icon icon={download.flags.includes("archive") ? FileArchiveIcon : FileIcon} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui text-foreground">{download.filename}</p>
        <p
          className={cn(
            "truncate text-xs text-subtle-foreground",
            (download.state === "failed" || download.state === "denied") && "text-status-failed",
          )}
        >
          {saving === undefined
            ? states[download.state]
            : `Saving to this device · ${Math.floor(saving * 100)}%`}
          {download.bytes > 0 && ` · ${formatBytes(download.bytes)}`}
          {risky && " · Executable: check it before running"}
        </p>
      </div>
      {risky && (
        <WarningIcon
          role="img"
          aria-label="Executable"
          size={14}
          className="shrink-0 text-status-failed"
        />
      )}
      {path && reveal && (
        <IconButton
          icon={FolderOpenIcon}
          label={revealWords().showFile(download.filename)}
          tip={revealWords().show}
          size="sm"
          onClick={() =>
            void reveal(path).catch(() => toast.error({ title: "Couldn't show the file" }))
          }
        />
      )}
      {save && (
        <IconButton
          icon={DeviceMobileIcon}
          label={`Save ${download.filename} to this device`}
          tip="Save to this device"
          size="sm"
          disabled={saving !== undefined}
          onClick={() => save(download)}
        />
      )}
      {path && (
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                icon={DotsThreeIcon}
                label={`More for ${download.filename}`}
                tip="More"
                size="sm"
              />
            }
          />
          <MenuContent align="end">
            <MenuItem
              icon={<Icon icon={CopyIcon} />}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(path)
                  .catch(() => toast.error({ title: "Couldn't copy the path" }))
              }
            >
              Copy path
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </li>
  );
}

/**
 * Downloads, in the toolbar's right pill: a ring turns around the arrow while a file arrives,
 * and the popover lists what the thread's tabs downloaded. Files stay in the thread's quarantine
 * on the daemon's machine and never open on their own; Show in Finder works when that machine
 * is this one, and anywhere else Save to this device fetches the file over the connection.
 */
export function DownloadsButton(props: {
  threadId: string;
  downloads: readonly BrowserDownloadView[];
  /** Opened from elsewhere too (the ⋯ menu's Downloads). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const reveal = useLocalReveal();
  const device = useSaveDownload(props.threadId);
  const { downloads } = props;
  const pending = downloads.filter((download) => download.state === "pending").length;
  const label = pending
    ? `Downloads · ${pending} downloading`
    : downloads.length
      ? `Downloads · ${downloads.length}`
      : "Downloads";
  const newest = downloads.findLast((download) => download.state === "complete" && download.path);
  return (
    <Popover
      {...(props.open === undefined ? {} : { open: props.open })}
      onOpenChange={(open) => props.onOpenChange?.(open)}
    >
      <Tip label={label}>
        <PopoverTrigger
          aria-label={label}
          className={cn(
            toolbarButton,
            "relative grid place-items-center text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
          )}
        >
          <DownloadSimpleIcon aria-hidden size={16} />
          {pending > 0 && (
            <span
              aria-hidden
              className="absolute inset-0.5 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground/70"
            />
          )}
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="flex w-80 flex-col gap-1 p-1">
        <div className="flex h-9 items-center gap-2 pr-1 pl-2">
          <PopoverTitle className="min-w-0 flex-1 text-ui font-medium">Downloads</PopoverTitle>
          {reveal && newest?.path && (
            <IconButton
              icon={FolderOpenIcon}
              label={revealWords().showFolder("downloads")}
              size="sm"
              onClick={() => void reveal(newest.path ?? "").catch(() => {})}
            />
          )}
        </div>
        {downloads.length === 0 ? (
          <p className="px-2 pb-3 text-ui text-muted-foreground">Nothing downloaded yet</p>
        ) : (
          <ul aria-label="Downloads" className="flex max-h-80 flex-col overflow-y-auto">
            {downloads.toReversed().map((download) => (
              <DownloadRow
                key={download.downloadId}
                download={download}
                reveal={reveal}
                save={reveal ? undefined : (each) => void device.save(each)}
                saving={device.saving.get(download.downloadId)}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
