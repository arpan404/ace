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

/** One provider mark and corner label everywhere an account is shown. */
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
  const label = siblings && siblings.length > 1 ? account?.shortLabel : undefined;
  const name = [providerNames[props.provider], account?.label, label && `label ${label}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className={cn("relative inline-flex shrink-0", props.className)}
      title={name}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <ProviderIcon
        {...props}
        acpAgentId={props.acpAgentId ?? account?.acpAgentId}
        className={undefined}
        decorative
      />
      {label && (
        <span
          style={{
            background: accountColors[account?.badgeColor ?? "neutral"],
            color: "var(--background)",
          }}
          className="absolute -right-1 -bottom-1 min-w-2.5 rounded-xs px-0.5 text-center text-[8px] leading-[11px] font-semibold shadow-[0_0_0_1px_var(--background)]"
        >
          {label}
        </span>
      )}
    </span>
  );
}
