import {
  ChartBarIcon,
  FilesIcon,
  MagnifyingGlassIcon,
  PlugsIcon,
  SignOutIcon,
} from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import {
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from "@/components/ui/menu.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useProfileName } from "@/lib/profile.ts";
import { connectionLabels } from "./connection-labels.ts";

/*
 * What the sidebar's menus hold, loaded after the first paint (`SidebarMenu`). The menus and
 * their triggers are there from the start; only their contents arrive a moment later.
 */

/** The less used places. */
const morePages: readonly {
  to: "/more/accounts" | "/more/files" | "/more/search";
  label: string;
  icon: IconGlyph;
}[] = [
  { to: "/more/accounts", label: "Usage & accounts", icon: ChartBarIcon },
  { to: "/more/files", label: "Files", icon: FilesIcon },
  { to: "/more/search", label: "Search", icon: MagnifyingGlassIcon },
];

export function MoreMenuContent() {
  const navigate = useNavigate();
  return (
    <MenuContent side="right" align="start">
      {morePages.map((page) => (
        <MenuItem
          key={page.to}
          icon={<Icon icon={page.icon} />}
          onClick={() => void navigate({ to: page.to })}
        >
          {page.label}
        </MenuItem>
      ))}
    </MenuContent>
  );
}

/** Who this is, the daemon connection, usage and connection settings. */
export function AccountMenuContent(props: { compact: boolean }) {
  const label = connectionLabels[useConnectionState()];
  const [name] = useProfileName();
  const connection = useDaemonConnection();
  const navigate = useNavigate();
  return (
    <MenuContent side={props.compact ? "right" : "top"} align={props.compact ? "end" : "start"}>
      <MenuGroup>
        {name && (
          <div className="truncate px-2.5 pt-1.5 text-ui font-medium text-foreground">{name}</div>
        )}
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
  );
}
