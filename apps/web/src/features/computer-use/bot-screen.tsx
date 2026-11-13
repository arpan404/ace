import type { ScreenInput, ScreenState } from "@ace/protocol";
import { useEffect, useEffectEvent } from "react";
import { LiveView } from "./live-view.tsx";
import { useScreenSession, type ScreenSession } from "./screen-session.ts";

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

/**
 * The latest taking of each session's controls, per screen channel: a number each view takes
 * when it asks for them. Only the holder of the latest may let them go.
 */
const takings = new WeakMap<ScreenSession, Map<string, number>>();
function claim(session: ScreenSession, sessionId: string): number {
  const bySession = takings.get(session) ?? new Map<string, number>();
  takings.set(session, bySession);
  const next = (bySession.get(sessionId) ?? 0) + 1;
  bySession.set(sessionId, next);
  return next;
}
const owns = (session: ScreenSession, sessionId: string, taking: number) =>
  takings.get(session)?.get(sessionId) === taking;

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
  const human = state?.controller === "human";
  // The person's controls while they drive. They are let go when the person hands back, when
  // this view goes (another surface, another bot) or the session changes, and when the answer to
  // taking them arrives after any of those; but only by the latest taking of that session, so a
  // late answer or cleanup never lets go of controls taken again since.
  useEffect(() => {
    if (!session || !sessionId || !props.driving) return;
    const mine = claim(session, sessionId);
    let gone = false;
    let held = false;
    const letGo = () => {
      if (!owns(session, sessionId, mine)) return;
      void session.request({ op: "controller", sessionId, controller: "none" }).catch(() => {});
    };
    session.request({ op: "controller", sessionId, controller: "human" }).then(
      () => {
        held = true;
        if (gone) letGo();
      },
      (error: unknown) => {
        if (!gone) refused(error);
      },
    );
    return () => {
      gone = true;
      if (held) letGo();
    };
  }, [session, sessionId, props.driving]);
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
