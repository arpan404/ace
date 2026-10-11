/*
 * Closing a terminal tab ends its shell. The tab kinds' `onClose` runs outside React with only
 * the thread and the tab. This hands the request to the showing client (`TerminalClient`).
 * Authenticated close delivery outlives its App and does not depend on optional panel services.
 * A request made before any client listens waits for the first to.
 */

export interface TerminalEnd {
  threadId: string;
  terminalId: string;
}

const listeners = new Set<(end: TerminalEnd) => void>();
const waiting: TerminalEnd[] = [];
/** Requests kept before any client has started listening. */
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
