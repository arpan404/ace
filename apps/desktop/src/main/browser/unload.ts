/**
 * What becomes of a page whose `beforeunload` handler asks to stay (Electron's
 * `will-prevent-unload`), decided at once because Electron needs the answer synchronously
 * (ADR 0067, "Leaving a page the person was editing"):
 *
 * - `leave`: an agent drives the tab and the person has not used this page: the unsaved
 *   changes are the agent's own.
 * - `stay`: an agent drives the tab but the person used this page: their changes are kept and
 *   the agent's navigation fails at once with `unsaved_changes`, never waiting out its timeout.
 * - `ask`: the person is leaving (their own click or key press led here), or no agent drives
 *   the tab: the person answers a leave prompt, as in any browser.
 */
export type UnloadChoice = "leave" | "stay" | "ask";

export function unloadChoice(facts: {
  agentDriving: boolean;
  personUsedPage: boolean;
  personLeaving: boolean;
}): UnloadChoice {
  if (facts.personLeaving || !facts.agentDriving) return "ask";
  return facts.personUsedPage ? "stay" : "leave";
}

/** The parts of a `WebContents` the guard listens to. */
export interface UnloadContents {
  on(event: "will-prevent-unload", listener: (event: { preventDefault(): void }) => void): unknown;
  on(
    event: "did-navigate",
    listener: (event: unknown, url: string, httpResponseCode: number) => void,
  ): unknown;
}

/**
 * Answers a native view's leave prompts. `personUsed` marks the person's own key press or click
 * on the page; a new document clears it. `ask` puts the prompt to the person and returns whether
 * they chose to leave; `refused` hears that the page stayed while an agent drove it.
 */
export class UnloadGuard {
  private personUsedPage = false;
  constructor(
    contents: UnloadContents,
    facts: () => { agentDriving: boolean; personLeaving: boolean },
    ask: () => boolean,
    refused: () => void,
  ) {
    contents.on("did-navigate", () => {
      this.personUsedPage = false;
    });
    contents.on("will-prevent-unload", (event) => {
      const choice = unloadChoice({ ...facts(), personUsedPage: this.personUsedPage });
      // Calling preventDefault ignores the page's handler: the page is left.
      if (choice === "leave" || (choice === "ask" && ask())) event.preventDefault();
      else if (choice === "stay") refused();
    });
  }
  personUsed(): void {
    this.personUsedPage = true;
  }
}
