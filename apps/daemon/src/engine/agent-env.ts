import type { ThreadId } from "@ace/protocol";

/**
 * The variables ace gives every agent session it starts (ADR 0176 §10): its own thread, never to
 * prompt, and the home its daemon uses, so `ace` in the agent's shell talks to the right daemon
 * about the right thread. Hints for an honest caller, not a security boundary. Pure.
 */
export function agentSessionEnv(input: {
  readonly threadId: ThreadId;
  /** The daemon's data dir; omitted when the engine wasn't given one (tests, children). */
  readonly home?: string | undefined;
}): Readonly<Record<string, string>> {
  return {
    ACE_THREAD_ID: input.threadId,
    ACE_NO_INPUT: "1",
    ...(input.home ? { ACE_HOME: input.home } : {}),
  };
}
