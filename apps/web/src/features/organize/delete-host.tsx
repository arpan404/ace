import { Suspense, useSyncExternalStore } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useDeleteConfirmation } from "./delete-confirmation.ts";

const DeleteDialog = deferredComponent(() =>
  import("./delete-dialog.tsx").then((module) => module.DeleteDialog),
);

export function DeleteConfirmationHost() {
  const confirmation = useDeleteConfirmation();
  const request = useSyncExternalStore(
    confirmation.subscribe,
    confirmation.getState,
    confirmation.getState,
  );
  return request ? (
    <Suspense fallback={null}>
      <DeleteDialog.Component request={request} onClose={() => confirmation.close()} />
    </Suspense>
  ) : null;
}
