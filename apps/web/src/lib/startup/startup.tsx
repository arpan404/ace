import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import {
  initialStartup,
  startupDataCapMs,
  startupLeaveMs,
  startupSlowMs,
  startupStalledMs,
  startupStep,
  type StartupEvent,
  type StartupState,
} from "./startup-state.ts";

type Schedule = (delayMs: number, run: () => void) => () => void;

/**
 * One page load's startup: the reducer's state plus what decides "first data is ready". The app
 * shell says when it has mounted and its route has resolved; any view still loading its first
 * data holds the screen up (`useStartupHold`). Once both are settled for a frame, or the cap runs
 * out, the screen leaves.
 */
export interface Startup {
  getSnapshot(): StartupState;
  subscribe(listener: () => void): () => void;
  dispatch(event: StartupEvent): void;
  /** A view loading its first data keeps the screen up; returns the release. */
  hold(): () => void;
  /** The app shell mounted and its first route resolved (or not, while it loads). */
  shell(settled: boolean): void;
  /** What "Connect manually…" does on this page, if anything. */
  connectManually(): (() => void) | undefined;
  offerConnectManually(run: (() => void) | undefined): void;
}

export function createStartup(options: {
  schedule: Schedule;
  /** The next animation frame (so holds registered in the same commit count). */
  frame: (run: () => void) => () => void;
}): Startup {
  let state = initialStartup;
  const listeners = new Set<() => void>();
  let holds = 0;
  let settled = false;
  let cancelFrame: (() => void) | undefined;
  let cancelCap: (() => void) | undefined;
  let manual: (() => void) | undefined;
  let waits: (() => void)[] = [];

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const check = () => {
    cancelFrame?.();
    cancelFrame = undefined;
    if (state.phase !== "loading" || !settled || holds > 0) return;
    cancelFrame = options.frame(() => {
      cancelFrame = undefined;
      if (state.phase === "loading" && settled && holds === 0)
        startup.dispatch({ type: "data-ready" });
    });
  };
  const startup: Startup = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(event) {
      const next = startupStep(state, event);
      if (next === state) return;
      const was = state.phase;
      state = next;
      if (state.phase === "loading" && was !== "loading")
        cancelCap = options.schedule(startupDataCapMs, () =>
          startup.dispatch({ type: "data-ready" }),
        );
      if (state.phase !== "loading") {
        cancelCap?.();
        cancelCap = undefined;
        cancelFrame?.();
        cancelFrame = undefined;
      }
      if (state.phase === "leaving" && was !== "leaving") {
        for (const stop of waits) stop();
        // The fade's end says when it's gone; this covers a fade that never runs (hidden window).
        options.schedule(startupLeaveMs, () => startup.dispatch({ type: "left" }));
      }
      emit();
      check();
    },
    hold() {
      if (state.phase === "leaving" || state.phase === "gone") return () => {};
      holds++;
      cancelFrame?.();
      cancelFrame = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        check();
      };
    },
    shell(next) {
      settled = next;
      check();
    },
    connectManually: () => manual,
    offerConnectManually(run) {
      if (manual === run) return;
      manual = run;
      emit();
    },
  };
  // Measured from the page's start: the first paint already shows the mark.
  waits = [
    options.schedule(startupSlowMs, () => startup.dispatch({ type: "slow" })),
    options.schedule(startupStalledMs, () => startup.dispatch({ type: "stalled" })),
  ];
  return startup;
}

export const StartupContext = createContext<Startup | undefined>(undefined);

const noState = () => initialStartup;
const noSubscribe = () => () => {};

/** This page's startup state; the initial state where no startup screen runs (tests). */
export function useStartupState(): StartupState {
  const startup = useContext(StartupContext);
  return useSyncExternalStore(
    startup?.subscribe ?? noSubscribe,
    startup?.getSnapshot ?? noState,
    startup?.getSnapshot ?? noState,
  );
}

export function useStartup(): Startup | undefined {
  return useContext(StartupContext);
}

/**
 * Keep the startup screen up while this view loads its first data, so boot never shows a
 * skeleton. Does nothing once the app is showing: later loads show their own placeholders.
 */
export function useStartupHold(active = true): void {
  const startup = useContext(StartupContext);
  useEffect(() => (active && startup ? startup.hold() : undefined), [startup, active]);
}

/** The app shell is mounted (so the daemon answered); `settled` once its route has resolved. */
export function useStartupShell(settled: boolean): void {
  const startup = useContext(StartupContext);
  useEffect(() => {
    if (!startup) return;
    startup.dispatch({ type: "connection", state: "ready" });
    startup.shell(settled);
  }, [startup, settled]);
  useEffect(() => () => startup?.shell(false), [startup]);
}

/** Before the app: where the connection has got to, while the startup screen covers it. */
export function useStartupConnection(
  state: "connecting" | "starting" | "reconnecting",
  connectManually?: () => void,
): void {
  const startup = useContext(StartupContext);
  useEffect(() => {
    startup?.dispatch({ type: "connection", state });
  }, [startup, state]);
  useEffect(() => {
    if (!startup) return;
    startup.offerConnectManually(connectManually);
    return () => {
      if (startup.connectManually() === connectManually) startup.offerConnectManually(undefined);
    };
  }, [startup, connectManually]);
}

/** Another full screen took over (connection form, failure): the startup screen gets out of the way. */
export function useStartupHandoff(): void {
  const startup = useContext(StartupContext);
  useEffect(() => {
    startup?.dispatch({ type: "handoff" });
  }, [startup]);
}
