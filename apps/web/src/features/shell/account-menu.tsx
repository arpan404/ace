import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useConnectionState } from "@ace/client-react";
import { UserIcon } from "@ace/icons";
import { initials } from "@ace/ui-core";

import { useProfileName } from "@/lib/profile.ts";
import { useAccountPicture, useAceAccount, useSpace } from "@/features/ace-account/index.ts";
import { Icon } from "@/components/icon.tsx";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { railPlaceClass } from "@/components/rail-place.ts";
import { connectionDot, connectionLabels } from "./connection-labels.ts";
import { BetaPeel } from "./beta-peel.tsx";
import { SidebarMenu } from "./sidebar-menu.tsx";

const AccountMenuContent = deferredComponent(() =>
  import("./account-menu-content.tsx").then((module) => module.AccountMenuContent),
);
/**
 * The profile at the foot of the rail: the ace account's picture, else the person's initials
 * on a neutral disc (their ace account's name, else the name they gave in Settings › Profile; a silhouette until either). Connection trouble is a quiet dot on the disc
 * (the screen says it in words once); a healthy connection adds none. The connection is part of
 * the button's name rather than a live region, so a flapping connection isn't read out each
 * time. Its menu is the only way to Usage. On a beta build the disc wears the beta's peel, and
 * the build's name joins the button's name and tip.
 */
export function AccountMenu(props: { beta?: string | undefined }) {
  const state = useConnectionState();
  const [profileName] = useProfileName();
  const { session } = useAceAccount();
  const picture = useAccountPicture();
  const name = session?.account.name || profileName;
  const letters = initials(name);
  // The window's organization, when it shows one (ADR 0206 §1.5): named and marked on the disc.
  const org = useSpace().shown?.org;
  const shown = org ? `${name.trim() || "You"}, ${org.name}` : name.trim() || "You";
  const connection =
    state === "ready"
      ? `${shown}, account`
      : `${shown}, account, ace ${connectionLabels[state].toLowerCase()}`;
  const label = props.beta ? `${connection}, ${props.beta}` : connection;
  return (
    <SidebarMenu
      tip={props.beta ? `${shown}, ${props.beta}` : shown}
      trigger={
        <button type="button" aria-label={label} data-part="rail-item" className={railPlaceClass}>
          <span className="relative grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
            {picture ? (
              <ProfileAvatar name={name} picture={picture} className="size-7" iconSize={14} />
            ) : letters ? (
              <span
                aria-hidden
                className="text-2xs font-semibold tracking-[0.02em] text-foreground"
              >
                {letters}
              </span>
            ) : (
              <Icon icon={UserIcon} size={14} />
            )}
            {props.beta && <BetaPeel />}
            {org && (
              <span
                aria-hidden
                data-space-mark=""
                className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-[4px] bg-foreground text-[8px] leading-none font-semibold text-background ring-2 ring-sidebar"
              >
                {initials(org.name).slice(0, 1) || "O"}
              </span>
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
