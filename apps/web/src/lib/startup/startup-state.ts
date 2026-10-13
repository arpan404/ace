/**
 * The startup screen's state: a pure reducer over what boot learns, and the view it implies.
 * The screen covers the window from first paint until the app has its first real data, then
 * leaves once. It never comes back for that page: a connection lost later is the shell's to say.
 */

/** How long a start may take before the screen says "Starting ace…". */
export const startupSlowMs = 600;
/** How long before a start that hasn't finished offers a way out (logs, restart, by hand). */
export const startupStalledMs = 20_000;
/**
 * How long the app may stay mounted under the screen waiting on its first data. Past this the
 * screen leaves anyway and the views say what they are still loading.
 */
export const startupDataCapMs = 8_000;
/** Longer than the cross-fade (--motion-slow), for when no transition runs (a hidden window). */
export const startupLeaveMs = 450;

export type StartupPhase =
  /** Booting: the daemon is starting or the client is connecting. */
  | "starting"
  /** The desktop's own daemon failed to start. */
  | "failed"
  /** The connection dropped (or the daemon is restarting) before the app was shown. */
  | "reconnecting"
  /** Connected, the app is mounted underneath and loading its first data. */
  | "loading"
  /** Cross-fading out to the app (or to a screen that took over). */
  | "leaving"
  /** Gone for the life of this page. */
  | "gone";

export interface StartupState {
  phase: StartupPhase;
  /** The start has taken long enough to say so. */
  slow: boolean;
  /** The start has taken long enough to offer a way out. */
  stalled: boolean;
  /** Why the daemon failed, as the desktop reported it (shown through friendly copy). */
  error?: string | undefined;
}

export const initialStartup: StartupState = { phase: "starting", slow: false, stalled: false };

/** The desktop daemon's states, as far as startup cares (`DaemonState` in apps/desktop). */
export type StartupDaemonState =
  | "starting"
  | "running"
  | "restarting"
  | "unreachable"
  | "failed"
  | "stopping"
  | "stopped"
  | "unavailable";

export type StartupEvent =
  | { type: "slow" }
  | { type: "stalled" }
  /** The desktop's daemon reported a state. */
  | { type: "daemon"; state: string; message?: string | undefined }
  /** The client's connection before the app is shown. */
  | { type: "connection"; state: "connecting" | "starting" | "reconnecting" | "ready" }
  /** Every view mounted at boot has its first data (or the cap ran out). */
  | { type: "data-ready" }
  /** Another full screen took over (connection form, boot failure): get out of its way. */
  | { type: "handoff" }
  /** The person asked to try again from the failed state. */
  | { type: "retry" }
  /** The fade finished. */
  | { type: "left" };

const finished = (phase: StartupPhase) => phase === "leaving" || phase === "gone";

export function startupStep(state: StartupState, event: StartupEvent): StartupState {
  if (event.type === "left") return state.phase === "leaving" ? { ...state, phase: "gone" } : state;
  // Once the screen is on its way out it stays out: nothing re-covers the app.
  if (finished(state.phase)) return state;
  switch (event.type) {
    case "slow":
      return state.slow ? state : { ...state, slow: true };
    case "stalled":
      return state.stalled ? state : { ...state, slow: true, stalled: true };
    case "handoff":
      return { ...state, phase: "leaving" };
    case "data-ready":
      return state.phase === "loading" ? { ...state, phase: "leaving" } : state;
    case "retry":
      return state.phase === "failed"
        ? { phase: "starting", slow: true, stalled: false, error: undefined }
        : state;
    case "daemon":
      return daemonStep(state, event.state, event.message);
    case "connection":
      return connectionStep(state, event.state);
  }
}

function daemonStep(state: StartupState, daemon: string, message: string | undefined) {
  if (daemon === "failed") return { ...state, phase: "failed" as const, error: message };
  // The app is already mounted underneath: a daemon blip is the shell's to report.
  if (state.phase === "loading") return state;
  if (daemon === "restarting" || daemon === "unreachable")
    return { ...state, phase: "reconnecting" as const, error: undefined };
  if (daemon === "starting" || daemon === "running")
    return state.phase === "starting" && state.error === undefined
      ? state
      : { ...state, phase: "starting" as const, error: undefined };
  return state;
}

function connectionStep(
  state: StartupState,
  connection: "connecting" | "starting" | "reconnecting" | "ready",
): StartupState {
  // A failed daemon stays failed until it reports starting again or the person retries.
  if (state.phase === "failed") return state;
  if (connection === "ready") return { ...state, phase: "loading" };
  if (state.phase === "loading") return state;
  if (connection === "reconnecting") return { ...state, phase: "reconnecting" };
  return state.phase === "starting" ? state : { ...state, phase: "starting" };
}

export type StartupAction = "retry" | "logs" | "restart" | "connect" | "reload" | "quit";

export interface StartupView {
  /** The screen is mounted (covering, or fading out). */
  shown: boolean;
  /** Fading out: the app underneath is ready. */
  leaving: boolean;
  /** The one status line under the mark, if the wait has earned one. */
  message?: string | undefined;
  /** The failure in plain words, when the daemon failed. */
  failure?: string | undefined;
  actions: StartupAction[];
}

/** What the person can do here, given what this window can actually offer. */
export interface StartupAbilities {
  /** The desktop's daemon controls exist (restart, logs, quit). */
  desktop: boolean;
  /** Logs can be opened. */
  logs: boolean;
  /** A connection form can take over. */
  connect: boolean;
}

export function startupView(
  state: StartupState,
  abilities: StartupAbilities,
  describeFailure: (reason: string) => string = (reason) => reason,
): StartupView {
  if (state.phase === "gone") return { shown: false, leaving: false, actions: [] };
  if (state.phase === "leaving") return { shown: true, leaving: true, actions: [] };
  if (state.phase === "failed")
    return {
      shown: true,
      leaving: false,
      message: undefined,
      failure: describeFailure(state.error ?? ""),
      actions: [
        "retry",
        ...(abilities.logs ? (["logs"] as const) : []),
        ...(abilities.desktop ? (["quit"] as const) : []),
      ],
    };
  const message = !state.slow
    ? undefined
    : state.phase === "reconnecting"
      ? "Reconnecting…"
      : "Starting ace…";
  const actions: StartupAction[] = !state.stalled
    ? []
    : abilities.desktop
      ? [
          ...(abilities.logs ? (["logs"] as const) : []),
          "restart" as const,
          ...(abilities.connect ? (["connect"] as const) : []),
        ]
      : ["reload", ...(abilities.connect ? (["connect"] as const) : [])];
  return { shown: true, leaving: false, message, actions };
}
