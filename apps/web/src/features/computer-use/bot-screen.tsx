import type { ScreenInput, ScreenState } from "@ace/protocol";
import { useEffect, useEffectEvent } from "react";
import { LiveView } from "./live-view.tsx";
import { useScreenSession } from "./screen-session.ts";

/*
 * A Spade bot's screen, live: the app session its hidden thread started (or holds now), drawn by
 * computer use's live view. While the person drives they take the session's controls, so their
 * clicks and keys reach the app; when they hand back, the controls are let go for the bot to take
 * again. While the bot drives the view only shows.
 */

export interface BotScreenProps {
  /** The bot's hidden thread. */
  threadId: string;
  driving: boolean;
  label: string;
  /** Said while no session of the bot's shows. */
  waiting: string;
  /** Input or a change of control the computer refused. */
  onProblem(error: unknown): void;
}

const shown = new Set<ScreenState["lifecycle"]>(["starting", "live"]);

/** The bot's session: the one its thread holds now, else the newest its thread started. */
export function botSession(states: readonly ScreenState[], threadId: string) {
  const live = states.filter((state) => shown.has(state.lifecycle));
  return (
    live.find((state) => state.holder?.threadId === threadId) ??
    live.findLast((state) => state.threadId === threadId)
  );
}

export default function BotScreen(props: BotScreenProps) {
  const { session, snapshot } = useScreenSession();
  const state = botSession(snapshot.states, props.threadId);
  const sessionId = state?.sessionId;
  const refused = useEffectEvent((error: unknown) => props.onProblem(error));
  // The person's controls while they drive, let go once they hand back.
  const human = state?.controller === "human";
  useEffect(() => {
    if (!session || !sessionId) return;
    if (props.driving && !human)
      void session
        .request({ op: "controller", sessionId, controller: "human" })
        .catch((error: unknown) => refused(error));
    if (!props.driving && human)
      void session.request({ op: "controller", sessionId, controller: "none" }).catch(() => {});
  }, [session, sessionId, props.driving, human]);
  if (snapshot.unavailable)
    return (
      <p className="grid h-full place-items-center px-6 text-center text-ui text-muted-foreground">
        This computer can't show its screen here.
      </p>
    );
  if (!session || !sessionId)
    return (
      <p className="grid h-full place-items-center px-6 text-center text-ui text-muted-foreground">
        {props.waiting}
      </p>
    );
  const send = (input: ScreenInput) =>
    void session.request({ op: "input", sessionId, input }).catch(props.onProblem);
  return (
    <LiveView
      session={session}
      sessionId={sessionId}
      label={props.label}
      className="size-full"
      onInput={props.driving && human ? send : undefined}
    />
  );
}
