import type { ProviderKind } from "@ace/protocol";
import { SettingAddRow } from "@/components/setting-row.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { canAddAccounts } from "./actions.ts";
import { useAddAccount } from "./add-account-host.tsx";

const Form = deferredComponent(() =>
  import("./add-account-form.tsx").then((module) => module.AddAccountForm),
);

/** The "Add account" row of a provider's accounts card; absent where accounts can't be added. */
export function AddAccountRow(props: { provider: ProviderKind; label?: string; onOpen?(): void }) {
  const open = useAddAccount();
  if (!open || !canAddAccounts(props.provider)) return null;
  return (
    <SettingAddRow
      onPointerEnter={() => void Form.preload()}
      onClick={() => {
        props.onOpen?.();
        open(props.provider);
      }}
    >
      {props.label ?? "Add account"}
    </SettingAddRow>
  );
}
