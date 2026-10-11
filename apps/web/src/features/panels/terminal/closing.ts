/*
 * Closing a terminal tab ends its shell. The tab kinds' `prepareClose` runs outside React with only
 * the thread and the tab. This hands the request to the showing client (`TerminalClient`).
 * Authenticated close delivery outlives its App and does not depend on optional panel services.
 * Without an authenticated owner, removal is refused so its shell cannot be orphaned.
 */

export interface TerminalEnd {
  threadId: string;
  terminalId: string;
}

let activeEnd: ((end: TerminalEnd) => boolean) | undefined;

/** Accept only closes the current authenticated owner can durably retain. */
export function requestTerminalEnd(end: TerminalEnd): boolean {
  return activeEnd?.(end) ?? false;
}

/** The showing client prepares closes; a retired client never accepts another daemon's tab. */
export function onTerminalEnd(listener: (end: TerminalEnd) => boolean): () => void {
  activeEnd = listener;
  return () => {
    if (activeEnd === listener) activeEnd = undefined;
  };
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
