import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useConnectionState } from "@ace/client-react";
import { UserIcon } from "@phosphor-icons/react";
import { initials } from "@ace/ui-core";

import { useProfileName } from "@/lib/profile.ts";
import { Icon } from "@/components/icon.tsx";
import { railPlaceClass } from "@/components/rail-place.ts";
import { connectionDot, connectionLabels } from "./connection-labels.ts";
import { SidebarMenu } from "./sidebar-menu.tsx";

const AccountMenuContent = deferredComponent(() =>
  import("./account-menu-content.tsx").then((module) => module.AccountMenuContent),
);
/**
 * The profile at the foot of the rail: the person's initials on a neutral disc (a silhouette
 * until they give a name in Settings › General). Connection trouble is a quiet dot on the disc
 * (the screen says it in words once); a healthy connection adds none. The connection is part of
 * the button's name rather than a live region, so a flapping connection isn't read out each
 * time. Its menu is the only way to Usage.
 */
export function AccountMenu() {
  const state = useConnectionState();
  const [name] = useProfileName();
  const letters = initials(name);
  const shown = name.trim() || "You";
  const label =
    state === "ready"
      ? `${shown}, account`
      : `${shown}, account, ace ${connectionLabels[state].toLowerCase()}`;
  return (
    <SidebarMenu
      tip={shown}
      trigger={
        <button type="button" aria-label={label} className={railPlaceClass}>
          <span className="relative grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
            {letters ? (
              <span
                aria-hidden
                className="text-2xs font-semibold tracking-[0.02em] text-foreground"
              >
                {letters}
              </span>
            ) : (
              <Icon icon={UserIcon} size={14} />
            )}
            {state !== "ready" && (
              <span
                aria-hidden
                className={`absolute -top-px -right-px size-2 rounded-full ring-2 ring-sidebar ${connectionDot[state]}`}
              />
            )}
          </span>
        </button>
      }
    >
      <AccountMenuContent.Component />
    </SidebarMenu>
  );
}
