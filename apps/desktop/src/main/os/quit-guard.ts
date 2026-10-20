/** How recently an agent must have driven a browser page for Quit to ask first. */
export const agentBrowseWindowMs = 60_000;

/**
 * Whether a CDP command the daemon sends a native view is an agent at work on the page (reading
 * or acting), not the plumbing every view gets (request decisions, screencast frames, setup).
 */
export function agentWork(method: string): boolean {
  return (
    method.startsWith("Input.") ||
    method.startsWith("DOM.") ||
    method.startsWith("Accessibility.") ||
    method === "Page.navigate" ||
    method === "Page.reload" ||
    method === "Page.captureScreenshot" ||
    method === "Runtime.evaluate" ||
    method === "Runtime.callFunctionOn"
  );
}

export interface QuitFacts {
  /** Agents working right now, as the daemon link last reported. */
  working: number;
  /** When an agent last worked in a native browser page here; never: -Infinity. */
  lastAgentBrowse: number;
  now: number;
  /** The system is shutting down or logging out: never hold it up with a question. */
  systemShutdown: boolean;
}

/**
 * Whether Quit asks once before closing (#952): only while agents work and one of them used a
 * browser page within `agentBrowseWindowMs`, since quitting closes the pages under them. An
 * idle app, agents working elsewhere, or a system shutdown quit without asking.
 */
export function quitNeedsConfirmation(facts: QuitFacts): boolean {
  if (facts.systemShutdown || facts.working <= 0) return false;
  return facts.now - facts.lastAgentBrowse < agentBrowseWindowMs;
}
