import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { providerNames } from "@ace/ui-core";
import { useAccountViews } from "@/lib/account-views.ts";
import { cn } from "@/lib/cn.ts";
import { ProviderIcon, type ProviderIconProps } from "./provider-icons.tsx";

/** Theme-aware ink tokens, also used for project marks. Their inverse is the surface colour. */
export const accountColors: Record<AccountBadgeColor, string> = {
  neutral: "var(--foreground)",
  blue: "var(--project-8)",
  green: "var(--project-5)",
  amber: "var(--project-2)",
  rose: "var(--project-12)",
  violet: "var(--project-10)",
};

/** Provider glyph and a separate account dot, only when there are accounts to distinguish. */
export function ProviderAccountIcon(
  props: ProviderIconProps & {
    instance?: string | undefined;
    account?: AccountView | undefined;
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
      className={cn("inline-flex shrink-0 items-center gap-0.5", props.className)}
      title={name}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <ProviderIcon
        {...props}
        acpAgentId={props.acpAgentId ?? account?.acpAgentId}
        className={undefined}
        decorative
      />
      {multiple && account && (
        <span
          role="img"
          aria-label={`${account.label} account`}
          title={`${account.label} account`}
          style={{ background: accountColors[account.badgeColor ?? "neutral"] }}
          className="size-1 shrink-0 rounded-full"
        />
      )}
    </span>
  );
}
