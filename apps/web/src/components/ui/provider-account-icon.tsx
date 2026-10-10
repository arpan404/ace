import type { CSSProperties } from "react";
import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { providerNames } from "@ace/ui-core";
import { useAccountViews } from "@/lib/account-views.ts";
import { cn } from "@/lib/cn.ts";
import { ProviderIcon, type ProviderIconProps } from "./provider-icons.tsx";
import { Tip } from "./tooltip.tsx";
import { accountBadge, accountBadgeOverlayStyle } from "./account-badge.ts";

/** Theme-aware ink tokens, also used for project marks. Their inverse is the surface colour. */
export const accountColors: Record<AccountBadgeColor, string> = {
  neutral: "var(--foreground)",
  blue: "var(--project-8)",
  green: "var(--project-5)",
  amber: "var(--project-2)",
  rose: "var(--project-12)",
  violet: "var(--project-10)",
};

/** Provider glyph and readable account mark, when accounts need distinguishing. */
export function ProviderAccountIcon(
  props: ProviderIconProps & {
    instance?: string | undefined;
    account?: AccountView | undefined;
    accountLabel?: boolean;
    tooltip?: boolean;
  },
) {
  const accounts = useAccountViews();
  const own = accounts.data?.filter((account) => account.provider === props.provider);
  const account =
    props.account ??
    (props.instance
      ? own?.find((entry) => entry.id === props.instance)
      : (own?.find((entry) => entry.isDefault) ?? own?.[0]));
  const siblings = own?.filter(
    (entry) => props.provider !== "acp" || entry.acpAgentId === account?.acpAgentId,
  );
  if (account && !props.accountLabel)
    return (
      <AccountBadge
        account={account}
        className={props.className}
        decorative={props.decorative}
        tooltip={props.tooltip}
      />
    );
  const multiple = siblings !== undefined && siblings.length > 1;
  const size = props.size ?? 16;
  const name = [providerNames[props.provider], account?.label].filter(Boolean).join(" · ");
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", props.className)}
      style={multiple && account ? { width: size + 2, height: size + 2 } : undefined}
      title={hoverTitle(props.tooltip, name, account?.shortLabel)}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <ProviderIcon
        {...props}
        size={size}
        acpAgentId={props.acpAgentId ?? account?.acpAgentId}
        className={undefined}
        decorative
      />
      {multiple && account && (
        <span
          role="img"
          title={hoverTitle(props.tooltip, `${account.label} account`)}
          aria-label={`${account.label} account`}
          style={
            { "--account-color": accountColors[account.badgeColor ?? "neutral"] } as CSSProperties
          }
          className={accountBadgeOverlayStyle}
        >
          {accountBadge(account.label, account.shortLabel)}
        </span>
      )}
    </span>
  );
}

function hoverTitle(
  enabled: boolean | undefined,
  name: string,
  shortLabel?: string,
): string | undefined {
  if (enabled === false) return undefined;
  return shortLabel ? `${name} · ${shortLabel}` : name;
}

/** Readable account identity shared by settings, usage and model sources. */
export function AccountBadge(props: {
  account: Pick<AccountView, "label" | "shortLabel" | "badgeColor">;
  className?: string | undefined;
  decorative?: boolean | undefined;
  tooltip?: boolean | undefined;
  focusable?: boolean | undefined;
}) {
  const { account } = props;
  const mark = (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
        props.focusable && "focus-ring",
        props.className,
      )}
      tabIndex={props.focusable ? 0 : undefined}
      style={{
        background: accountColors[account.badgeColor ?? "neutral"],
        color: "var(--background)",
      }}
      {...(props.decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": `${account.label} account` })}
    >
      {accountBadge(account.label, account.shortLabel)}
    </span>
  );
  return props.tooltip === false || props.decorative ? (
    mark
  ) : (
    <Tip label={account.label}>{mark}</Tip>
  );
}
