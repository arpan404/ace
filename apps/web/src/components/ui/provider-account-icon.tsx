import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { accountBadge, isPlainCliLogin, providerAccount, providerNames } from "@ace/ui-core";
import { useAccountViews } from "@/lib/account-views.ts";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { ProviderIcon, type ProviderIconProps } from "./provider-icons.tsx";
import { Tip } from "./tooltip.tsx";
import { accountBadgeGlyphs } from "./account-badge-icons.ts";

/** Theme-aware ink tokens, also used for project marks. Their inverse is the surface colour. */
export const accountColors: Record<AccountBadgeColor, string> = {
  neutral: "var(--foreground)",
  blue: "var(--project-8)",
  green: "var(--project-5)",
  amber: "var(--project-2)",
  rose: "var(--project-12)",
  violet: "var(--project-10)",
};

/**
 * The provider's glyph. The account is named in words (the title and accessible name, and the
 * model picker's chip), never as a letter on the glyph.
 */
export function ProviderAccountIcon(
  props: ProviderIconProps & {
    instance?: string | undefined;
    account?: AccountView | undefined;
    /** The accounts `instance` is one of, when not this window's: another machine's. */
    accounts?: readonly AccountView[] | undefined;
    tooltip?: boolean;
  },
) {
  const accounts = useAccountViews();
  const { account } = providerAccount(props.accounts ?? accounts.data, {
    provider: props.provider,
    instance: props.instance,
    account: props.account,
  });
  // The CLI's own login, never renamed, stands for the provider.
  const plain = account !== undefined && isPlainCliLogin(account);
  const name = [providerNames[props.provider], plain ? undefined : account?.label]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", props.className)}
      title={hoverTitle(props.tooltip, name, account?.shortLabel)}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <ProviderIcon
        {...props}
        size={props.size ?? 16}
        acpAgentId={props.acpAgentId ?? account?.acpAgentId}
        className={undefined}
        decorative
      />
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
  account: Pick<AccountView, "label" | "shortLabel" | "badgeColor" | "badgeIcon">;
  className?: string | undefined;
  decorative?: boolean | undefined;
  tooltip?: boolean | undefined;
  focusable?: boolean | undefined;
  /** Colour is retained only in the account colour editor. */
  colorPreview?: boolean | undefined;
}) {
  const { account } = props;
  const Glyph = account.badgeIcon ? accountBadgeGlyphs[account.badgeIcon] : undefined;
  const mark = (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-2xs font-medium text-muted-foreground",
        props.focusable && "focus-ring",
        props.className,
      )}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
      tabIndex={props.focusable ? 0 : undefined}
      data-account-badge=""
      {...part("avatar", undefined, "account")}
      style={
        props.colorPreview
          ? {
              background: accountColors[account.badgeColor ?? "neutral"],
              color: "var(--background)",
            }
          : undefined
      }
      {...(props.decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": `${account.label} account` })}
    >
      {Glyph ? (
        <Glyph aria-hidden size="1.15em" weight="bold" />
      ) : (
        accountBadge(account.label, account.shortLabel)
      )}
    </span>
  );
  return props.tooltip === false || props.decorative ? (
    mark
  ) : (
    <Tip label={account.label}>{mark}</Tip>
  );
}
