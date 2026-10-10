import { useClient } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useMemo } from "react";

export interface DeleteRequest {
  title: string;
  running: string;
  confirm(): void;
}
class DeleteConfirmation {
  private request: DeleteRequest | undefined;
  private listeners = new Set<() => void>();
  getState = () => this.request;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(request: DeleteRequest) {
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
