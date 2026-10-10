import { useHostIdentity } from "@/lib/host-name.ts";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { DeviceMobileIcon, PlugsIcon, SignOutIcon } from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { MenuGroup, MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { cn } from "@/lib/cn.ts";
import { connectionDot, connectionLabels } from "./connection-labels.ts";

/**
 * The sidebar title's menu ("ace ▾"), loaded after the first paint: the daemon this window
 * talks to. Its state and address, pairing another device, the connection settings, and
 * leaving it. The person and the app are the avatar's menu.
 */
export function DaemonMenuItems() {
  const state = useConnectionState();
  const connection = useDaemonConnection();
  const navigate = useNavigate();
  const identity = useHostIdentity();
  const host = identity?.displayName ?? "This machine";
  return (
    <>
      <MenuGroup>
        <div className="flex items-center gap-2 px-2.5 pt-1.5 text-ui font-medium text-foreground">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", connectionDot[state])} />
          <MachineLabel name={host} icon={identity?.icon} /> · {connectionLabels[state]}
        </div>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        icon={<DeviceMobileIcon aria-hidden />}
        onClick={() => void navigate({ to: "/settings/remote" })}
      >
        Pair a device…
      </MenuItem>
      <MenuItem
        icon={<PlugsIcon aria-hidden />}
        onClick={() => void navigate({ to: "/settings/advanced" })}
      >
        Connection settings
      </MenuItem>
      {connection.mode === "daemon" && (
        <>
          <MenuSeparator />
          <MenuItem icon={<SignOutIcon aria-hidden />} onClick={connection.disconnect}>
            Disconnect
          </MenuItem>
        </>
      )}
    </>
  );
}
