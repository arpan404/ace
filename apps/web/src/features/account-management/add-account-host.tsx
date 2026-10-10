import type { ProviderKind } from "@ace/protocol";
import { createContext, Suspense, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { canAddAccounts } from "./actions.ts";

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
        <Suspense fallback={null}>
          <AddDialog.Component provider={provider} onClose={() => setProvider(undefined)} />
        </Suspense>
      )}
    </AddContext.Provider>
  );
}

const useAddAccount = () => useContext(AddContext);

export function AddAccountButton(props: {
  provider: ProviderKind;
  label?: string;
  onOpen?(): void;
}) {
  const open = useAddAccount();
  if (!open || !canAddAccounts(props.provider)) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onPointerEnter={() => void Form.preload()}
      onClick={() => {
        props.onOpen?.();
        open(props.provider);
      }}
    >
      {props.label ?? "Add account"}
    </Button>
  );
}
