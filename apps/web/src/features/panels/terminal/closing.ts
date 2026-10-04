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
