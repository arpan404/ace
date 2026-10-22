import { ArrowClockwiseIcon, CheckIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { openRelease, useDesktopUpdate, type UpdateStatus } from "@/boot/desktop-updates.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { hasUpdate, showsReleaseNotes, updateAction, updateLabel } from "./update-status.ts";

const ring = 2 * Math.PI * 13;

/** The confirm dialog and release-notes card load after the first paint. */
const UpdateOverlays = deferredComponent(() =>
  import("./update-overlays.tsx").then((module) => module.UpdateOverlays),
);

/** The update's glyph: a download (with a dot, or its progress), a restart, a spinner. */
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
  return (
    <span className="relative grid size-4 place-items-center">
      <ArrowClockwiseIcon aria-hidden size={16} />
      <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-sidebar">
        <CheckIcon aria-hidden size={7} weight="bold" />
      </span>
    </span>
  );
}

/**
 * The app's update, beside the Settings gear (desktop only), shown only while there is one:
 * background checks find it. A click downloads it, with its progress on the icon, and a
 * downloaded one restarts the app after asking. Hovering it shows what changed.
 */
export function UpdateButton(props: { scope?: object }) {
  const update = useDesktopUpdate(props.scope);
  const [confirming, setConfirming] = useState(false);
  /** Agents the Restart would stop: undefined while counting, null when unknown. */
  const [busy, setBusy] = useState<number | null | undefined>(undefined);
  const [triggerFocused, setTriggerFocused] = useState(false);
  const [hoverIntent, setHoverIntent] = useState(false);
  const [overlaysArmed, setOverlaysArmed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const status = update.status;
  const live = status !== undefined && hasUpdate(status);
  // Warm the closed layers while idle (desktop only) so opening them never waits on the network.
  useEffect(() => {
    if (!live) return;
    return whenIdle(() => void UpdateOverlays.preload().catch(() => {}));
  }, [live]);
  if (!status || !live) return null;
  const label = updateLabel(status);
  const action = updateAction(status);
  const act = () => {
    if (action === "download") update.download();
    else if (action === "open-release" && status.releaseUrl)
      openRelease(status.releaseUrl, props.scope);
    else if (action === "install") {
      // Arm in the same press that asks: the swap commits with the dialog, never mid-press.
      setOverlaysArmed(true);
      setConfirming(true);
      setBusy(undefined);
      void update.busy().then((count) => setBusy(count ?? null));
    }
  };
  const button = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-disabled={action === "none" || undefined}
      onClick={act}
      onFocus={() => setTriggerFocused(true)}
      onBlur={() => setTriggerFocused(false)}
      onPointerEnter={() => setHoverIntent(true)}
      onPointerLeave={() => setHoverIntent(false)}
      className={cn(
        "relative grid size-8 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground aria-disabled:cursor-default",
      )}
    >
      <UpdateGlyph status={status} />
    </button>
  );
  // The eager trigger stays on screen until the layers take over; afterwards they stay
  // mounted and toggle in place, so the dialog keeps its close animation and focus return. A
  // dialog opening takes focus itself; otherwise focus follows the trigger across the one swap.
  if (!(overlaysArmed || confirming || showsReleaseNotes(status)))
    return <Tip label={label}>{button}</Tip>;
  return (
    <Suspense fallback={<Tip label={label}>{button}</Tip>}>
      <UpdateOverlays.Component
        trigger={button}
        triggerRef={triggerRef}
        restoreFocus={triggerFocused && !confirming}
        popoverDefaultOpen={hoverIntent}
        label={label}
        status={status}
        scope={props.scope}
        confirming={confirming}
        busy={busy}
        onConfirmingChange={setConfirming}
        onInstall={() => update.install()}
      />
    </Suspense>
  );
}
