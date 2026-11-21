import type { ClientApi } from "@ace/client";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useAceAccountStore } from "./account-context.tsx";
import { PersonConfirmation } from "./confirm-person.tsx";

/** For actions whose feedback lives in the app's notification area. */
export function useConfirmPersonNotice() {
  const toast = useToast();
  const store = useAceAccountStore();
  return useCallback(
    (client: ClientApi, retry: () => void, freshSignIn = false) => {
      if (!store) return false;
      const id = toast.add({
        timeout: 0,
        title: (
          <PersonConfirmation
            store={store}
            client={client}
            freshSignIn={freshSignIn}
            onConfirmed={() => {
              toast.close(id);
              retry();
            }}
          />
        ),
      });
      return true;
    },
    [store, toast],
  );
}
