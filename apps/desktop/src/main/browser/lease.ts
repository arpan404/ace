export type Controller = "agent" | "human";

/**
 * Who drives an embedded browser view. Human input takes control at once; the agent gets it
 * back only when the person hands it back. While a human controls the view, the agent may
 * still read (DOM, accessibility, screenshots) but its input is refused.
 */
export class ControllerLease {
  private holder: Controller = "agent";

  get controller(): Controller {
    return this.holder;
  }

  /** Returns true when control changed hands. */
  take(by: Controller): boolean {
    if (this.holder === by) return false;
    this.holder = by;
    return true;
  }

  /** Whether the agent may run this CDP method now. */
  agentMay(method: string): boolean {
    return this.holder === "agent" || !isInput(method);
  }
}

/** CDP methods that act on the page as a user would. */
export function isInput(method: string): boolean {
  return (
    method.startsWith("Input.") ||
    method === "Page.navigate" ||
    method === "Page.reload" ||
    method === "Page.navigateToHistoryEntry" ||
    method === "Runtime.evaluate" ||
    method === "Runtime.callFunctionOn"
  );
}
