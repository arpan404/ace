import { Suspense, useSyncExternalStore } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useArchiveConfirmation, useDeleteConfirmation } from "./delete-confirmation.ts";

const DeleteDialog = deferredComponent(() =>
  import("./delete-dialog.tsx").then((module) => module.DeleteDialog),
);
const ArchiveDialog = deferredComponent(() =>
  import("./archive-dialog.tsx").then((module) => module.ArchiveDialog),
);

export function DeleteConfirmationHost() {
  const confirmation = useDeleteConfirmation();
  const request = useSyncExternalStore(
    confirmation.subscribe,
    confirmation.getState,
    confirmation.getState,
  );
  return (
    <>
      {request && (
        <Suspense fallback={null}>
          <DeleteDialog.Component request={request} onClose={() => confirmation.close()} />
        </Suspense>
      )}
      <ArchiveConfirmationHost />
    </>
  );
}

/** The question archiving a running thread asks: stop it too, or keep it running. */
function ArchiveConfirmationHost() {
  const confirmation = useArchiveConfirmation();
  const request = useSyncExternalStore(
    confirmation.subscribe,
    confirmation.getState,
    confirmation.getState,
  );
  return request ? (
    <Suspense fallback={null}>
      <ArchiveDialog.Component request={request} onClose={() => confirmation.close()} />
    </Suspense>
  ) : null;
}
