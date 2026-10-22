import type { ScreenState } from "@ace/protocol";
import { chooserWaitingCopy, screenSession, visibleSessions } from "@ace/ui-core/computer-use";

/*
 * Computer use's apps as the phone lists them, worded by the web's own rules
 * (`@ace/ui-core/computer-use`): agent-held first, who has each one and what it is doing. Pure.
 */

/** Names the agent holding an app: one of the open thread's, by name; anyone else's generically. */
export type ScreenAgentLabel = (holder: {
  threadId: string;
  agentId: string;
}) => string | undefined;

/**
 * The sessions as the phone lists them: the shared words, plus who held each last. `machine`
 * names the computer whose sharing dialog a waiting session needs the person at.
 */
export function phoneScreenSessions(
  states: readonly ScreenState[],
  label: ScreenAgentLabel,
  machine?: string,
) {
  return visibleSessions(states).map((state) => {
    const view = screenSession(state, (holder) => label(holder) ?? "An agent");
    return {
      sessionId: view.sessionId,
      app: view.app,
      detail: view.detail ?? "",
      status: view.awaitingChoice ? `${chooserWaitingCopy(machine)}.` : view.status,
      /** The machine's sharing dialog is waiting for the person there: Cancel is all there is. */
      awaitingChoice: view.awaitingChoice,
      /** A whole screen: watch only, nobody takes control. */
      viewOnly: view.viewOnly,
      tone: view.tone,
      mode: view.mode,
      foreground: view.foreground,
      capturing: view.capturing,
      controller: view.controller,
      lifecycle: view.lifecycle,
      error: view.error ?? "",
      stoppable: view.stoppable,
      secureInputAllowed: view.secureInputAllowed,
    };
  });
}
