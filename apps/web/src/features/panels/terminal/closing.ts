/*
 * Closing a terminal tab ends its shell. The tab kinds' `onClose` runs outside React with only
 * the thread and the tab, while the shells belong to the panel services of a daemon client, so
 * this hands the request across: the showing client listens (`TerminalClient`), and a request
 * made while none does waits for the next to.
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

/** Whether the client knows a terminal's shell has ended; undefined when it doesn't know. */
export type TerminalProbe = (threadId: string, terminalId: string) => boolean | undefined;

let activeProbe: TerminalProbe | undefined;

/**
 * Answer whether terminals have ended, for the client whose screen shows (one at a time: a
 * client that went away, or another daemon's, never answers for this one). Returns the undo.
 */
export function setTerminalProbe(probe: TerminalProbe): () => void {
  activeProbe = probe;
  return () => {
    if (activeProbe === probe) activeProbe = undefined;
  };
}

/**
 * Whether a terminal's shell has ended, as the showing client knows. Unknown counts as still
 * running: closing its tab asks first rather than ending a shell blind.
 */
export function terminalEnded(threadId: string, terminalId: string): boolean {
  return activeProbe?.(threadId, terminalId) === true;
}
