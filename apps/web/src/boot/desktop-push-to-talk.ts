import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/*
 * Push to talk from anywhere, in the desktop app (ADR 0134, amended). The desktop's global
 * shortcut says `start` on the first press and `send` on the next; its small floating indicator
 * can say `cancel`. A start opens the main Spade, whose composer listens; the composer says how
 * the turn goes back to the desktop, which shows it in the indicator. In a browser there is no
 * shortcut, so none of this runs.
 */

export type PushPhase = "start" | "send" | "cancel";

interface TalkBridge {
  onTalk(listener: (phase: unknown) => void): () => void;
  talkState(state: string): Promise<unknown>;
}

function bridgeOf(scope: object): TalkBridge | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const spade: unknown =
    typeof ace === "object" && ace !== null ? Reflect.get(ace, "spade") : undefined;
  if (typeof spade !== "object" || spade === null) return undefined;
  const onTalk: unknown = Reflect.get(spade, "onTalk");
  const talkState: unknown = Reflect.get(spade, "talkState");
  if (typeof onTalk !== "function" || typeof talkState !== "function") return undefined;
  return {
    onTalk: (listener) => {
      const stop: unknown = Reflect.apply(onTalk, spade, [listener]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    talkState: (state) => Promise.resolve(Reflect.apply(talkState, spade, [state])),
  };
}

const isPhase = (value: unknown): value is PushPhase =>
  value === "start" || value === "send" || value === "cancel";

/** A start that came before the main Spade's composer was there to hear it. */
let waiting = false;
const listeners = new Set<(phase: PushPhase) => void>();

/** Hears the desktop's shortcut for as long as the app runs; a start opens the main Spade. */
export function usePushToTalk(scope: object = globalThis) {
  const navigate = useNavigate();
  useEffect(() => {
    const bridge = bridgeOf(scope);
    if (!bridge) return;
    return bridge.onTalk((phase) => {
      if (!isPhase(phase)) return;
      if (phase === "start") {
        void navigate({ to: "/spade" });
        if (listeners.size === 0) {
          waiting = true;
          return;
        }
      }
      if (phase === "cancel") waiting = false;
      for (const listener of listeners) listener(phase);
    });
  }, [navigate, scope]);
}

/** The main Spade's composer hears presses here; a start that waited for it arrives at once. */
export function onPushToTalk(listener: (phase: PushPhase) => void): () => void {
  listeners.add(listener);
  if (waiting) {
    waiting = false;
    queueMicrotask(() => listener("start"));
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A push to talk whose composer went away before anything was said (the screen remounted it):
 * the next main composer to listen takes it up.
 */
export function resumePushToTalk() {
  if (listeners.size > 0) {
    queueMicrotask(() => {
      for (const listener of listeners) listener("start");
    });
    return;
  }
  waiting = true;
}

/** Tells the desktop's indicator how the turn goes; nothing in a browser. */
export function reportPushToTalk(state: string, scope: object = globalThis) {
  void bridgeOf(scope)
    ?.talkState(state)
    .catch(() => {});
}
