import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { revealer } from "@/boot/open-external.ts";
import { formatBytes } from "@/components/format-bytes.ts";
import { StatusPill } from "@/components/status-pill.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import type { BrowserDownloadView } from "../sources.ts";

const states: Record<BrowserDownloadView["state"], string> = {
  pending: "Waiting",
  complete: "Downloaded",
  denied: "Denied",
  failed: "Failed",
  too_large: "Too large",
};

/**
 * What the thread's pages downloaded. Files stay in the thread's quarantine on the daemon's
 * machine and never open on their own; executables and archives say so. Show in Finder works in
 * the desktop app when the daemon runs on this Mac.
 */
export function DownloadsButton(props: { downloads: readonly BrowserDownloadView[] }) {
  const toast = useToast();
  const connection = useDaemonConnection();
  const local =
    connection.mode === "daemon" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(safeHost(connection.url));
  const reveal = local ? revealer() : undefined;
  const { downloads } = props;
  if (downloads.length === 0) return null;
  const pending = downloads.filter((download) => download.state === "pending").length;
  const label = pending ? `Downloads · ${pending} waiting` : `Downloads · ${downloads.length}`;
  return (
    <Popover>
      <Tip label={label}>
        <PopoverTrigger
          aria-label={label}
          className="relative grid size-7 place-items-center rounded-sm text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <DownloadSimpleIcon aria-hidden size={16} />
          {pending > 0 && (
            <span
              aria-hidden
              data-tone="needs-you"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-(--tone)"
            />
          )}
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="flex w-80 flex-col gap-1">
        <PopoverTitle className="text-ui font-medium">Downloads</PopoverTitle>
        <p className="text-xs text-subtle-foreground">
          Kept in this thread on the daemon's machine. Nothing opens on its own.
        </p>
        <ul aria-label="Downloads" className="mt-1 flex flex-col">
          {downloads.map((download) => (
            <li
              key={download.downloadId}
              className="flex flex-col gap-1 border-b py-2 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-ui">{download.filename}</p>
                <StatusPill
                  tone={
                    download.state === "complete"
                      ? "done"
                      : download.state === "pending"
                        ? "waiting"
                        : "failed"
                  }
                  label={states[download.state]}
                />
              </div>
              <p className="text-xs text-subtle-foreground">
                {formatBytes(download.bytes)} · {download.mimeType}
                {download.flags.includes("executable") && (
                  <b className="ml-1.5 font-medium text-status-failed">
                    Executable: check it before running
                  </b>
                )}
                {download.flags.includes("archive") && " · Archive"}
              </p>
              {download.state === "complete" && download.path && (
                <div className="flex gap-1">
                  {reveal && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void reveal(download.path ?? "").catch(() =>
                          toast.error({ title: "Couldn't show the file" }),
                        )
                      }
                    >
                      Show in Finder
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void navigator.clipboard?.writeText(download.path ?? "").then(
                        () => toast.add({ title: "Path copied" }),
                        () => toast.error({ title: "Couldn't copy the path" }),
                      )
                    }
                  >
                    Copy path
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
