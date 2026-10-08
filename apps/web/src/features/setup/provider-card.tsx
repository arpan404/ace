import { providerNames, type ReadinessView } from "@ace/ui-core";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";

export function ProviderRow(props: {
  row: ProviderReadiness;
  view: ReadinessView;
  next?: boolean;
}) {
  const name = providerNames[props.row.provider];
  return (
    <li aria-label={name}>
      <ProviderSetupRow
        provider={props.row.provider}
        name={name}
        missing={props.view.state === "not_installed"}
        view={props.view}
        updateAvailable={props.row.updateAvailable}
      />
    </li>
  );
}
