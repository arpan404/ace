import { useConnectionState } from "@ace/client-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { useSettingsLoaded, type SettingControl } from "./data/use-settings.ts";

export const offlineReason = "Reconnect to change settings stored on ace";

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
  return !loaded && offline ? "Not connected; showing nothing until ace answers." : undefined;
}

export { DisabledReason } from "@/components/ui/disabled-reason.tsx";
