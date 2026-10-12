import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import type { ProviderKind } from "@ace/protocol";
import { createContext, Suspense, useContext, useState, type ReactNode } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { canAddAccounts } from "./actions.ts";
import { SettingAction } from "@/components/setting-row.tsx";

const Form = deferredComponent(() =>
  import("./add-account-form.tsx").then((module) => module.AddAccountForm),
);
const AddDialog = deferredComponent(() =>
  import("./add-account-dialog.tsx").then((module) => module.AddAccountDialog),
);
const AddContext = createContext<((provider: ProviderKind) => void) | undefined>(undefined);

/** Every entry point opens this same named-account flow. */
export function AddAccountHost(props: { children: ReactNode }) {
  const [provider, setProvider] = useState<ProviderKind>();
  return (
    <AddContext.Provider value={setProvider}>
      {props.children}
      {provider && (
        <LocalBoundary label="the account dialog" fallback={null}>
          <Suspense fallback={null}>
            <AddDialog.Component provider={provider} onClose={() => setProvider(undefined)} />
          </Suspense>
        </LocalBoundary>
      )}
    </AddContext.Provider>
  );
}

const useAddAccount = () => useContext(AddContext);

/** The "+ Add account" row of a provider's accounts card; absent where accounts can't be added. */
export function AddAccountRow(props: { provider: ProviderKind; label?: string; onOpen?(): void }) {
  const open = useAddAccount();
  if (!open || !canAddAccounts(props.provider)) return null;
  return (
    <SettingAction
      onPointerEnter={() => void Form.preload()}
      onClick={() => {
        props.onOpen?.();
        open(props.provider);
      }}
    >
      {props.label ?? "Add account"}
    </SettingAction>
  );
}
