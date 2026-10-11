import type { AccountView } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";

/** The same provider mark, badge and full name in limits and account usage totals. */
export function AccountIdentity(props: { account: AccountView; tooltip?: string | undefined }) {
  const { account } = props;
  const name = `${account.providerLabel} · ${account.label}`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProviderIcon provider={account.provider} acpAgentId={account.acpAgentId} size={16} />
      <AccountBadge account={account} tooltip={false} />
      <Tip label={props.tooltip ?? name}>
        <span tabIndex={0} className="min-w-0 flex-1 truncate rounded-xs focus-ring">
          {name}
        </span>
      </Tip>
    </div>
  );
}
