import { useClient } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useMemo } from "react";

export interface DeleteRequest {
  title: string;
  running: string;
  confirm(): void;
}

/** Archiving a thread whose tree still works or waits on the person: stop it too, or not. */
export interface ArchiveRequest {
  title: string;
  /** What is still going on: "2 subagents and 1 background command are still running." */
  running: string;
  stopAndArchive(): void;
  archive(): void;
}

/** One question a thread action waits on, asked by a dialog the app shell hosts. */
class Confirmation<Request> {
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

/** One confirmation per client, so every window part opening it reaches the same dialog. */
function perClient<Request>() {
  const confirmations = new WeakMap<ClientApi, Confirmation<Request>>();
  return (client: ClientApi) => {
    let confirmation = confirmations.get(client);
    if (!confirmation) {
      confirmation = new Confirmation<Request>();
      confirmations.set(client, confirmation);
    }
    return confirmation;
  };
}

const deletes = perClient<DeleteRequest>();
const archives = perClient<ArchiveRequest>();

export function useDeleteConfirmation() {
  const client = useClient();
  return useMemo(() => deletes(client), [client]);
}

export function useArchiveConfirmation() {
  const client = useClient();
  return useMemo(() => archives(client), [client]);
}
