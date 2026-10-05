/*
 * Closing a terminal tab ends its shell. The tab kinds' `onClose` runs outside React with only
 * the thread and the tab, while the shells belong to the panel services of a daemon client, so
 * this hands the request across: each client's services listen (`onTerminalEnd`), and a request
 * made before any have loaded waits for the first to do so.
 */

export interface TerminalEnd {
  threadId: string;
  terminalId: string;
}

const listeners = new Set<(end: TerminalEnd) => void>();
const waiting: TerminalEnd[] = [];
/** Requests kept while no client's services have loaded yet. */
const keptWaiting = 64;

/** End a terminal's shell because its tab closed. */
export function requestTerminalEnd(end: TerminalEnd): void {
  if (!listeners.size) {
    waiting.push(end);
    if (waiting.length > keptWaiting) waiting.shift();
    return;
  }
  for (const listener of listeners) listener(end);
}

/** Receive requests to end terminals, starting with any made before this was called. */
export function onTerminalEnd(listener: (end: TerminalEnd) => void): () => void {
  listeners.add(listener);
  for (const end of waiting.splice(0)) listener(end);
  return () => listeners.delete(listener);
}

/** Whether a client knows a terminal's shell has ended; undefined when it doesn't know. */
export type TerminalProbe = (threadId: string, terminalId: string) => boolean | undefined;

const probes = new Set<TerminalProbe>();

/** Answer whether terminals have ended (each client's services do, once loaded). */
export function onTerminalProbe(probe: TerminalProbe): () => void {
  probes.add(probe);
  return () => probes.delete(probe);
}

/**
 * Whether a terminal's shell has ended, as far as any client knows. Unknown counts as still
 * running: closing its tab asks first rather than ending a shell blind.
 */
export function terminalEnded(threadId: string, terminalId: string): boolean {
  for (const probe of probes) if (probe(threadId, terminalId)) return true;
  return false;
}
