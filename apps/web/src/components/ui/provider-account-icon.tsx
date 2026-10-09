import type { CSSProperties } from "react";
import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { providerNames } from "@ace/ui-core";
import { useAccountViews } from "@/lib/account-views.ts";
import { cn } from "@/lib/cn.ts";
import { ProviderIcon, type ProviderIconProps } from "./provider-icons.tsx";
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
  const multiple = siblings !== undefined && siblings.length > 1;
  const name = [providerNames[props.provider], account?.label].filter(Boolean).join(" · ");
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center",
        multiple && account && "pr-1.5 pb-1.5",
        props.className,
      )}
      title={account?.shortLabel ? `${name} · ${account.shortLabel}` : name}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <ProviderIcon
        {...props}
        size={props.size ?? 16}
        acpAgentId={props.acpAgentId ?? account?.acpAgentId}
        className={undefined}
        decorative
      />
      {multiple && account && (
        <span
          role="img"
          title={`${account.label} account`}
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
