import { useConnectionState } from "@ace/client-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { useSettingsLoaded, type SettingControl } from "./data/use-settings.ts";

export const offlineReason = "Reconnect to change settings stored on the daemon";

/**
 * The slot a daemon setting's control sits in: a skeleton until the daemon has answered (never
 * a default dressed up as the value), the reason it's disabled while offline, and a spinner
 * once a write is slow. The control itself takes `disabled={control.offline}`.
 */
export function DaemonSlot(props: {
  control: Pick<SettingControl<unknown>, "loaded" | "offline" | "pending">;
  children: ReactNode;
}) {
  const { control } = props;
  if (!control.loaded) return <Skeleton className="h-7 w-28 rounded-md" />;
  return (
    <>
      {control.pending && <Spinner label="Saving" />}
      <DisabledReason reason={control.offline ? offlineReason : undefined}>
        {props.children}
      </DisabledReason>
    </>
  );
}

/**
 * A section's note while the daemon has never answered and the app isn't connected: its
 * controls show skeletons, never defaults, until it does.
 */
export function useNotConnectedNote(): string | undefined {
  const loaded = useSettingsLoaded();
  const offline = useConnectionState() !== "ready";
  return !loaded && offline
    ? "Not connected; showing nothing until the daemon answers."
    : undefined;
}

/**
 * A control that can be disabled and still say why: it sits in a wrapper whose tooltip gives
 * the reason, focusable only while there is one (a disabled button gets no pointer or focus
 * events itself). The wrapper is always there, so the control never remounts when the reason
 * comes or goes.
 */
export function DisabledReason(props: { reason: string | undefined; children: ReactNode }) {
  return (
    <Tooltip disabled={!props.reason}>
      <TooltipTrigger
        render={
          <span
            tabIndex={props.reason ? 0 : undefined}
            className="inline-flex rounded-md focus-ring"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.reason}</TooltipContent>
    </Tooltip>
  );
}
