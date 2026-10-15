import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { providerNames } from "@ace/ui-core";
import { useAccountViews } from "@/lib/account-views.ts";
import { cn } from "@/lib/cn.ts";
import { ProviderIcon, type ProviderIconProps } from "./provider-icons.tsx";
import { Tip } from "./tooltip.tsx";
import { accountBadge } from "./account-badge.ts";
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
 * Provider glyph and, when accounts need distinguishing, the account's mark as a bubble on the
 * glyph's corner, cut out of the surface beneath.
 */
export function ProviderAccountIcon(
  props: ProviderIconProps & {
    instance?: string | undefined;
    account?: AccountView | undefined;
    /** False hides the account mark where room is short; the accessible name keeps it. */
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
  const multiple = siblings !== undefined && siblings.length > 1;
  const size = props.size ?? 16;
  const bubble = multiple && account && props.accountLabel !== false;
  const name = [providerNames[props.provider], account?.label].filter(Boolean).join(" · ");
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        // The bubble hangs past the glyph's corner; keep it clear of whatever follows.
        bubble && "me-1",
        props.className,
      )}

      title={hoverTitle(props.tooltip, name, account?.shortLabel)}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <span className="inline-flex" style={bubble ? bubbleCut : undefined}>
        <ProviderIcon
          {...props}
          size={size}
          acpAgentId={props.acpAgentId ?? account?.acpAgentId}
          className={undefined}
          decorative
        />
      </span>
      {bubble && account && (
        <AccountBadge
          account={account}
          tooltip={props.tooltip}
          className="absolute -right-1 -bottom-[3px] size-[11px] bg-foreground text-[7px] leading-none font-semibold tracking-tight text-background"
          decorative
        />
      )}
    </span>
  );
}

/**
 * The bubble's outline, cut out of the glyph rather than drawn in a surface colour, so it reads
 * the same on any background: plain, hovered or selected rows, glass. Centred on the 11px
 * bubble that sits 4px right of and 3px below the glyph, with 1.5px to spare.
 */
const bubbleCut = {
  maskImage:
    "radial-gradient(circle at calc(100% + 1.5px) calc(100% + 2.5px), transparent 7px, #000 7.5px)",
};

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
      tabIndex={props.focusable ? 0 : undefined}
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
