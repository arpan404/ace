import type { DeviceRow } from "@ace/ui-core";
import {
  AndroidLogoIcon,
  AppleLogoIcon,
  CaretRightIcon,
  DeviceMobileIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { Problem } from "./device-tab.tsx";
import { DevicesMenu } from "./devices-menu.tsx";
import { useDevices } from "./use-devices.ts";

/** The workspace tab that shows one device (`device` kind, one tab per simulator or emulator). */
export const deviceTab = (row: Pick<DeviceRow, "id" | "name">) => ({
  kind: "device",
  id: row.id,
  title: row.name,
});

function DeviceList(props: {
  rows: readonly DeviceRow[];
  open: ReadonlySet<string>;
  onOpen(row: DeviceRow): void;
}) {
  return (
    <ul aria-label="Devices" className="flex flex-col gap-0.5 px-1.5">
      {props.rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => props.onOpen(row)}
            className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none transition-colors duration-(--dur-1) hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)]"
          >
            <Icon
              icon={row.platform === "ios" ? AppleLogoIcon : AndroidLogoIcon}
              size={16}
              className="text-muted-foreground"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium">{row.name}</span>
              <span className="block truncate text-xs text-subtle-foreground">{row.detail}</span>
            </span>
            {row.live && <span className="text-xs text-muted-foreground">Live</span>}
            {props.open.has(row.id) && <span className="text-xs text-subtle-foreground">Open</span>}
            <CaretRightIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Devices: the catalog of the iOS Simulators and Android emulators on the daemon's machine.
 * Enable them here; each device opens as its own tab, where it is approved for the thread,
 * booted, watched live and driven. Opening another device opens another tab beside it.
 */
export function DevicesTab(props: { threadId: string }) {
  const devices = useDevices(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const workspace = useScopeWorkspace(props.threadId);
  const open = new Set(workspace.tabs.filter((tab) => tab.kind === "device").map((tab) => tab.id));
  const { view } = devices;
  if (!view.connected)
    return view.failure ? (
      <EmptyState
        icon={DeviceMobileIcon}
        title="Devices disconnected"
        description={`${view.failure.message} ${view.failure.hint}`.trim()}
        action={<Button onClick={devices.reconnect}>Reconnect</Button>}
      />
    ) : (
      <div className="grid h-full place-items-center">
        <Spinner label="Connecting to devices" />
      </div>
    );
  if (!view.enabled)
    return (
      <EmptyState
        icon={DeviceMobileIcon}
        title="Simulators and emulators"
        description="Let ace see and drive the iOS Simulators and Android emulators on this machine. Agents only reach a device you approve for their thread."
        action={
          <div className="flex flex-col items-center gap-3">
            <Button variant="primary" disabled={view.pending} onClick={() => devices.enable(true)}>
              Enable devices
            </Button>
            {view.problem && <Problem problem={view.problem} />}
          </div>
        }
      />
    );
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col pt-2 pb-6">
      <div className="flex h-10 items-center justify-between pr-1.5 pl-4">
        <h2 className="text-xs font-medium text-subtle-foreground">On this machine</h2>
        {/* Turning devices off is machine-wide, so it sits with the catalog. */}
        <DevicesMenu devices={devices} />
      </div>
      {view.rows.length === 0 ? (
        view.pending ? (
          <ListSkeleton label="devices" shape="row" rows={2} className="px-4" />
        ) : (
          <p className="px-4 py-2 text-sm text-muted-foreground">
            No simulators or emulators found on this machine. Create one in Xcode or Android Studio
            and it shows here.
          </p>
        )
      ) : (
        <DeviceList rows={view.rows} open={open} onOpen={(row) => actions.open(deviceTab(row))} />
      )}
      <div className="flex flex-col gap-2 px-4 pt-3">
        {view.problem && <Problem problem={view.problem} />}
        {view.notes.map((note) => (
          <Problem key={note.message} problem={note} />
        ))}
      </div>
    </div>
  );
}
