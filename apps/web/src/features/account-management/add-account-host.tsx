import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import type { ProviderKind } from "@ace/protocol";
import { createContext, Suspense, useContext, useState, type ReactNode } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

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

/** Opens the host's flow for a provider; undefined outside an `AddAccountHost`. */
export const useAddAccount = () => useContext(AddContext);
