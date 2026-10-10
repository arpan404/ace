import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
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
        <LocalBoundary label="the account dialog" fallback={null}>
          <Suspense fallback={null}>
            <AddDialog.Component provider={provider} onClose={() => setProvider(undefined)} />
          </Suspense>
        </LocalBoundary>
      )}
    </AddContext.Provider>
  );
}

export const useAddAccount = () => useContext(AddContext);

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

/** Provider and usage pages keep the same form beside their accounts, including key entry. */
export function AddAccountInline(props: { provider: ProviderKind }) {
  const [open, setOpen] = useState(false);
  if (!canAddAccounts(props.provider)) return null;
  return open ? (
    <LocalBoundary label="the account dialog" fallback={null}>
      <Suspense fallback={null}>
        <Form.Component
          provider={props.provider}
          name={providerNames[props.provider]}
          onClose={() => setOpen(false)}
        />
      </Suspense>
    </LocalBoundary>
  ) : (
    <Button
      size="sm"
      variant="ghost"
      onPointerEnter={() => void Form.preload()}
      onClick={() => setOpen(true)}
    >
      Add account
    </Button>
  );
}
