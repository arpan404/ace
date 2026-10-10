import { useClient } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";

interface Request {
  title: string;
  running: string;
  confirm(): void;
}
class DeleteConfirmation {
  private request: Request | undefined;
  private listeners = new Set<() => void>();
  getState = () => this.request;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(request: Request) {
    this.request = request;
    this.emit();
  }
  close() {
    this.request = undefined;
    this.emit();
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
}
const confirmations = new WeakMap<ClientApi, DeleteConfirmation>();
export function useDeleteConfirmation() {
  const client = useClient();
  return useMemo(() => {
    let confirmation = confirmations.get(client);
    if (!confirmation) {
      confirmation = new DeleteConfirmation();
      confirmations.set(client, confirmation);
    }
    return confirmation;
  }, [client]);
}
export function DeleteConfirmationHost() {
  const confirmation = useDeleteConfirmation();
  const request = useSyncExternalStore(
    confirmation.subscribe,
    confirmation.getState,
    confirmation.getState,
  );
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) confirmation.close();
      }}
    >
      <DialogContent>
        <DialogTitle>Delete thread?</DialogTitle>
        <DialogDescription>
          {request?.title} will be permanently deleted. {request?.running}
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => confirmation.close()}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              confirmation.close();
              request?.confirm();
            }}
          >
            {request?.running ? "Stop and delete" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
