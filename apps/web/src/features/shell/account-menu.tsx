import { useConnectionState } from "@ace/client-react";
import { ChartBarIcon, PlugsIcon, SignOutIcon, UserIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuGroup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";

const stateLabels = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  fatal: "Disconnected",
} as const;

/** The account button at the foot of the rail. Its dot is the daemon connection, nothing more. */
export function AccountMenu() {
  const state = useConnectionState();
  const connection = useDaemonConnection();
  const navigate = useNavigate();
  const label = stateLabels[state];
  return (
    <Menu>
      <MenuTrigger
        aria-label="Account and connection"
        className="relative mt-0.5 grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[color,transform] duration-(--dur-1) hover:text-foreground active:scale-[0.94]"
      >
        <Icon icon={UserIcon} size={14} />
        <span
          role="status"
          aria-label={`Daemon: ${label}`}
          className={cn(
            "absolute -right-px -bottom-px size-[9px] rounded-full shadow-[0_0_0_2px_rgb(var(--rail-rgb))]",
            state === "ready"
              ? "bg-status-done"
              : "bg-rail shadow-[inset_0_0_0_1.5px_var(--subtle-foreground),0_0_0_2px_rgb(var(--rail-rgb))]",
          )}
        />
      </MenuTrigger>
      <MenuContent side="right" align="end">
        <MenuGroup>
          <MenuLabel>
            {connection.mode === "fake" ? "Fake daemon (dev)" : "Daemon"} · {label}
          </MenuLabel>
          <div className="truncate px-2.5 pb-1.5 font-mono text-[11.5px] text-subtle-foreground">
            {connection.url}
          </div>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          icon={<ChartBarIcon aria-hidden size={16} />}
          onClick={() => void navigate({ to: "/more/accounts" })}
        >
          Usage & accounts
        </MenuItem>
        <MenuItem
          icon={<PlugsIcon aria-hidden size={16} />}
          onClick={() => void navigate({ to: "/settings/general" })}
        >
          Connection settings
        </MenuItem>
        {connection.mode === "daemon" && (
          <>
            <MenuSeparator />
            <MenuItem icon={<SignOutIcon aria-hidden size={16} />} onClick={connection.disconnect}>
              Disconnect
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
