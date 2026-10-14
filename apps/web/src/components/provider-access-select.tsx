import type { AccessMode, ProviderKind } from "@ace/protocol";
import { useAccessModes } from "@/lib/use-permission-modes.ts";
import { AccessSelect } from "./access-select.tsx";

/** The access modes a provider supports, or the defaults for its new threads. */
export function ProviderAccessSelect(props: {
  provider: ProviderKind | undefined;
  value: AccessMode | undefined;
  onChange(value: AccessMode | undefined): void;
}) {
  const { offers, loading } = useAccessModes(props.provider);
  return (
    <AccessSelect
      label="Access"
      value={props.value}
      inheritLabel="Default"
      offers={offers}
      disabled={loading}
      onChange={props.onChange}
    />
  );
}
