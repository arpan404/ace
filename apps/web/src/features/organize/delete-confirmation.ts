import { perWindow } from "@/lib/per-window.ts";

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

/*
 * One confirmation per window, so every part opening it reaches the dialog the shell hosts, also
 * from another machine's thread or row (ADR 0102). A request carries its own `confirm`, made
 * against the asking view's client, so the dialog needs no machine of its own.
 */
const deletes = perWindow(() => new Confirmation<DeleteRequest>());
const archives = perWindow(() => new Confirmation<ArchiveRequest>());

export const DeleteConfirmationProvider = deletes.Provider;
export const ArchiveConfirmationProvider = archives.Provider;
export const useDeleteConfirmation = deletes.use;
export const useArchiveConfirmation = archives.use;
