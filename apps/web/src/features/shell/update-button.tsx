import {
  ArrowClockwiseIcon,
  ArrowsClockwiseIcon,
  CheckIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { openRelease, useDesktopUpdate, type UpdateStatus } from "@/boot/desktop-updates.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { UpdateNotes } from "./update-notes.tsx";
import { hasUpdate, showsReleaseNotes, updateAction, updateLabel } from "./update-status.ts";

const ring = 2 * Math.PI * 13;

/** The state's glyph: a refresh to check, a download (with a dot, or its progress), a restart. */
function UpdateGlyph(props: { status: UpdateStatus }) {
  const { status } = props;
  if (status.state === "installing") return <Spinner className="text-foreground" />;
  if (status.state === "downloading") {
    const percent = Math.max(0, Math.min(100, status.percent ?? 0));
    return (
      <span className="relative grid size-8 place-items-center">
        <svg aria-hidden viewBox="0 0 32 32" className="absolute inset-0 size-full -rotate-90">
          <circle cx="16" cy="16" r="13" fill="none" strokeWidth="1.5" className="stroke-border" />
          <circle
            cx="16"
            cy="16"
            r="13"
            fill="none"
            strokeWidth="1.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={ring}
            strokeDashoffset={ring * (1 - percent / 100)}
            className="transition-[stroke-dashoffset] duration-(--motion-base) motion-reduce:transition-none"
          />
        </svg>
        <DownloadSimpleIcon aria-hidden size={16} />
      </span>
    );
  }
  if (status.state === "available")
    return (
      <span className="relative grid size-4 place-items-center">
        <DownloadSimpleIcon aria-hidden size={16} />
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-sidebar"
        />
      </span>
    );
  if (status.state === "downloaded")
    return (
      <span className="relative grid size-4 place-items-center">
        <ArrowClockwiseIcon aria-hidden size={16} />
        <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-sidebar">
          <CheckIcon aria-hidden size={7} weight="bold" />
        </span>
      </span>
    );
  return (
    <ArrowsClockwiseIcon
      aria-hidden
      size={16}
      className={status.state === "checking" ? "motion-safe:animate-spin" : undefined}
    />
  );
}

/**
 * The app's update, beside the Settings gear (desktop only). It checks for updates when
 * clicked; a found update downloads on the next click, with its progress on the icon, and a
 * downloaded one restarts the app after asking. Hovering an update in hand shows what changed.
 */
export function UpdateButton(props: { scope?: object }) {
  const update = useDesktopUpdate(props.scope);
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const status = update.status;
  if (!status || status.state === "disabled") return null;
  const label = updateLabel(status);
  const action = updateAction(status);
  const held = hasUpdate(status);
  const act = () => {
    if (action === "check")
      void update.check().then((result) => {
        if (result?.state === "error")
          toast.error({
            kind: "desktop-update",
            title: "Couldn't check for updates",
            description: result.error?.message ?? "Check your connection and try again.",
          });
      });
    else if (action === "download") update.download();
    else if (action === "open-release" && status.releaseUrl)
      openRelease(status.releaseUrl, props.scope);
    else if (action === "install") setConfirming(true);
  };
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-disabled={action === "none" || undefined}
      onClick={act}
      className={cn(
        "relative grid size-8 place-items-center rounded-md transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg aria-disabled:cursor-default",
        held
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <UpdateGlyph status={status} />
    </button>
  );
  const confirm = (
    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart to install ace {status.version}?</DialogTitle>
          <DialogDescription>
            ace waits for running agents to finish, then restarts. New work waits until it's back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setConfirming(false);
              update.install();
            }}
          >
            Restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  if (!showsReleaseNotes(status))
    return (
      <>
        <Tip label={label}>{button}</Tip>
        {confirm}
      </>
    );
  return (
    <>
      <Popover
        onOpenChange={(_open, details) => {
          // A click acts (download, restart); the notes open on hover and focus.
          if (details.reason === "trigger-press") details.cancel();
        }}
      >
        <PopoverTrigger openOnHover delay={150} closeDelay={150} render={button} />
        <PopoverContent side="top" align="start" className="p-0" initialFocus={false}>
          <UpdateNotes status={status} scope={props.scope} />
        </PopoverContent>
      </Popover>
      {confirm}
    </>
  );
}
