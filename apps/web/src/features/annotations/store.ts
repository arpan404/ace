import type { BrowserAnnotation } from "@ace/protocol";
import { useSyncExternalStore } from "react";

/*
 * Where the two halves of annotating meet for one thread: the composer that holds the draft's
 * annotations, and the browser tab that drives the page. Each registers a port while mounted;
 * the other side looks it up when it needs it.
 */

/** The thread composer's side: the draft's annotations and its Send. */
export interface ComposerAnnotationPort {
  /** Add or update a record; a new one's element crop follows when it is captured. */
  save(annotation: BrowserAnnotation, crop?: Promise<File | undefined>): void;
  /** Replace the screenshot of the page at `url`. */
  page(url: string, file: File): void;
  remove(id: string): void;
  clear(): void;
  /** Send the composer's message, as the page bar's Send asks. */
  submit(): void;
  annotations(): readonly BrowserAnnotation[];
}

/** The browser tab's side: the page that can show the markers. */
export interface AnnotationSessionPort {
  /** The page the thread's browser shows now. */
  url(): string | undefined;
  /** Reopen a marker's comment in the page, starting annotate mode first if needed. */
  edit(id: string): void;
  /** The composer dropped records: take their markers off the page. */
  remove(id: string): void;
  clear(): void;
}

class Ports<T> {
  private ports = new Map<string, T>();
  private listeners = new Set<() => void>();
  get = (threadId: string): T | undefined => this.ports.get(threadId);
  register(threadId: string, port: T): () => void {
    this.ports.set(threadId, port);
    this.notify();
    return () => {
      if (this.ports.get(threadId) !== port) return;
      this.ports.delete(threadId);
      this.notify();
    };
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export const composerPorts = new Ports<ComposerAnnotationPort>();
export const sessionPorts = new Ports<AnnotationSessionPort>();

export function useComposerPort(threadId: string): ComposerAnnotationPort | undefined {
  return useSyncExternalStore(composerPorts.subscribe, () => composerPorts.get(threadId));
}

export function useSessionPort(threadId: string): AnnotationSessionPort | undefined {
  return useSyncExternalStore(sessionPorts.subscribe, () => sessionPorts.get(threadId));
}
