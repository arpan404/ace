import type { ScreenGrant, ScreenPermissions, ScreenState } from "@ace/protocol";
import { alwaysAsks, appName } from "./app-names.ts";
import type { Tone } from "./status.ts";

/*
 * Computer use as people see it: which apps agents hold, in which mode, whether pixels are
 * being captured, and what to do when the daemon refuses. The daemon decides everything; these
 * rules only word it and order it.
 */

export interface ScreenSessionView {
  sessionId: string;
  bundleId: string;
  app: string;
  /** Window title or display, when the target names one. */
  detail: string | undefined;
  controller: ScreenState["controller"];
  holder: ScreenState["holder"];
  lifecycle: ScreenState["lifecycle"];
  /** "In the background" or "In the foreground". */
  mode: string;
  foreground: boolean;
  /** Pixels are being captured right now (the daemon's capture indicator). */
  capturing: boolean;
  /** One line: who has it and what it is doing. */
  status: string;
  tone: Tone;
  sensitive: boolean;
  secureInputAllowed: boolean;
  error: string | undefined;
  /** Stop can still matter: live, starting, or a failure that may still be capturing. */
  stoppable: boolean;
}

const lifecycleOrder: Record<ScreenState["lifecycle"], number> = {
  live: 0,
  starting: 1,
  stopping: 2,
  failed: 3,
  stopped: 4,
};

function targetBundle(state: ScreenState): string {
  return state.target.kind === "display"
    ? (state.target.bundleIds[0] ?? "")
    : state.target.bundleId;
}

/** One session in words. `agentLabel` names a holder (the agent's name, from its thread). */
export function screenSession(
  state: ScreenState,
  agentLabel: (holder: NonNullable<ScreenState["holder"]>) => string = () => "An agent",
): ScreenSessionView {
  const bundleId = targetBundle(state);
  const foreground = state.mode === "foreground";
  const who =
    state.controller === "agent"
      ? state.holder
        ? agentLabel(state.holder)
        : "An agent"
      : state.controller === "human"
        ? "You"
        : undefined;
  let status: string;
  let tone: Tone;
  switch (state.lifecycle) {
    case "starting":
      status = "Starting";
      tone = "working";
      break;
    case "stopping":
      status = "Stopping";
      tone = "idle";
      break;
    case "stopped":
      status = "Stopped";
      tone = "idle";
      break;
    case "failed":
      status = state.indicator ? "Failed · may still be capturing" : "Failed";
      tone = "failed";
      break;
    default:
      status =
        who === "You" ? "You're in control" : who ? `${who} is in control` : "Nobody is in control";
      tone =
        state.controller === "agent"
          ? "working"
          : state.controller === "human"
            ? "needs-you"
            : "idle";
  }
  return {
    sessionId: state.sessionId,
    bundleId,
    app:
      state.target.kind === "display" && state.target.bundleIds.length > 1
        ? `${appName(bundleId)} and ${state.target.bundleIds.length - 1} more`
        : appName(bundleId),
    detail: state.target.kind === "display" ? `Display ${state.target.displayId}` : undefined,
    controller: state.controller,
    holder: state.holder,
    lifecycle: state.lifecycle,
    mode: foreground ? "In the foreground" : "In the background",
    foreground,
    capturing: state.indicator,
    status,
    tone,
    sensitive: alwaysAsks(bundleId),
    secureInputAllowed: state.secureInputAllowed,
    error: state.error,
    stoppable:
      state.lifecycle === "live" ||
      state.lifecycle === "starting" ||
      (state.lifecycle === "failed" && state.indicator),
  };
}

/**
 * Sessions worth showing, agent-held first, then by app: every live one, and a stopping or
 * failed one until the daemon confirms capture ended. Stopped sessions leave.
 */
export function visibleSessions(states: readonly ScreenState[]): ScreenState[] {
  return states
    .filter((state) => state.lifecycle !== "stopped")
    .toSorted(
      (a, b) =>
        Number(b.controller === "agent") - Number(a.controller === "agent") ||
        lifecycleOrder[a.lifecycle] - lifecycleOrder[b.lifecycle] ||
        appName(targetBundle(a)).localeCompare(appName(targetBundle(b))),
    );
}

/** Where a Stop all stands: on its way, done (with how many apps it ended) or refused. */
export type StopAllState =
  | { state: "idle" }
  | { state: "stopping" }
  | { state: "stopped"; count: number }
  | { state: "failed"; reason: string };

/** Stop all's outcome in a line beside its button; nothing while idle or on its way. */
export function stopAllSummary(stop: StopAllState): string | undefined {
  if (stop.state === "stopped")
    return stop.count === 0
      ? "Computer use is off."
      : `Stopped ${stop.count} ${stop.count === 1 ? "app" : "apps"}. Computer use is off.`;
  if (stop.state === "failed") return `Couldn't stop everything: ${stop.reason}`;
  return undefined;
}

/** Sessions an agent controls, including ones with no capture running. */
export function agentSessions(states: readonly ScreenState[]): ScreenState[] {
  return states.filter((state) => state.controller === "agent" && state.lifecycle !== "stopped");
}

/** The profile and Settings show the same sessions, including human takeover. */
export function indicatorSessions(states: readonly ScreenState[]): ScreenState[] {
  return visibleSessions(states);
}

export interface GrantView {
  key: string;
  bundleId: string;
  app: string;
  scope: ScreenGrant["scope"];
  /** "This turn", "This thread", "Always". */
  scopeLabel: string;
  threadId: string | undefined;
  sensitive: boolean;
  grantedAt: number;
}

const scopeLabels: Record<ScreenGrant["scope"], string> = {
  turn: "This turn",
  thread: "This thread",
  always: "Always",
};
const scopeOrder: Record<ScreenGrant["scope"], number> = { always: 0, thread: 1, turn: 2 };

/** Grants by app name, the widest scope of an app first. */
export function grantRows(grants: readonly ScreenGrant[]): GrantView[] {
  return grants
    .map((grant) => ({
      key: `${grant.bundleId}:${grant.scope}:${grant.threadId ?? ""}:${grant.turnId ?? ""}`,
      bundleId: grant.bundleId,
      app: appName(grant.bundleId),
      scope: grant.scope,
      scopeLabel: scopeLabels[grant.scope],
      threadId: grant.threadId,
      sensitive: alwaysAsks(grant.bundleId),
      grantedAt: grant.grantedAt,
    }))
    .toSorted((a, b) => a.app.localeCompare(b.app) || scopeOrder[a.scope] - scopeOrder[b.scope]);
}

export type ScreenErrorCode =
  | "permission_denied"
  | "approval_required"
  | "screen_disabled"
  | "denied"
  | "read_only"
  | "target_gone"
  | "not_supported"
  | "bounds"
  | "busy"
  | "timeout"
  | "internal"
  | "target_busy"
  | "foreground_required"
  | "focus_changed"
  | "window_minimized"
  | "window_offscreen"
  | "secure_input_required"
  | "clipboard_changed"
  | "forbidden";

/**
 * Secure input for one session, said plainly: what it is, where it stands and what the person
 * can do. macOS marks password and other secure fields so other apps can't read or type into
 * them; ace keeps agents out of them until a person allows it for that session, and never logs
 * what is typed there.
 */
export function secureInputCopy(allowed: boolean): {
  /** The menu row's second line. */
  menu: string;
  /** The card's line: what it is and what to do. */
  explanation: string;
} {
  return allowed
    ? {
        menu: "The agent can type into password fields in this app now",
        explanation:
          "Secure input is on: the agent may type into password and other secure fields in this app until it stops or changes hands. What it types stays hidden from it and the log.",
      }
    : {
        menu: "Password fields block agent typing until you allow it here",
        explanation:
          "Secure input: macOS marks password and other secure fields, and ace keeps agents from typing into them. Allow it for this session, or take over and type it yourself. What is typed stays hidden from the agent and the log.",
      };
}

/** What a refusal means and what to do next, in one sentence each. */
export function screenProblem(
  code: string | undefined,
  fallback: string,
  holder?: string,
): { title: string; hint: string | undefined } {
  switch (code) {
    case "target_busy":
      return {
        title: `${holder ?? "Another agent"} is already using this app`,
        hint: "Take it over first. ace never moves an app between agents on its own.",
      };
    case "foreground_required":
      return {
        title: "This app ignores background input",
        hint: "The agent can ask to bring it to the front; you'll be asked to approve.",
      };
    case "screen_disabled":
      return { title: "Computer use is off", hint: "Turn it on in Settings › Computer use." };
    case "approval_required":
      return { title: "This app isn't approved", hint: "Allow it when the agent asks, or here." };
    case "permission_denied":
      return {
        title: "macOS hasn't granted a permission",
        hint: "Grant Screen Recording and Accessibility to Ace Screen Helper, then try again.",
      };
    case "focus_changed":
      return {
        title: "Focus moved during the action",
        hint: "Another app, window or the cursor changed. Refresh before trying again.",
      };
    case "window_minimized":
      return { title: "The window is minimized", hint: "Restore it, or pick another window." };
    case "window_offscreen":
      return {
        title: "The window is off screen",
        hint: "Move it onto a display, or pick another window.",
      };
    case "secure_input_required":
      return {
        title: "That's a password or secure field",
        hint: "Agents can't type there unless you allow secure input for this session.",
      };
    case "clipboard_changed":
      return {
        title: "Something else used the clipboard",
        hint: "Your clipboard wasn't restored. Refresh before pasting again.",
      };
    case "target_gone":
      return {
        title: "The app or window has closed",
        hint: "Start it again if you still need it.",
      };
    case "not_supported":
      return { title: "Not supported here", hint: undefined };
    case "denied":
      return { title: "Denied", hint: undefined };
    case "timeout":
      return {
        title: "No answer in time",
        hint: "Nothing changed. Try again if you still need it.",
      };
    case "read_only":
      return {
        title: "Read-only mode",
        hint: "This thread's permission mode refuses computer use.",
      };
    case "forbidden":
      return { title: "This device can't manage computer use", hint: "Use the Mac running ace." };
    default:
      return { title: fallback, hint: undefined };
  }
}

/**
 * What Settings can say about macOS's grants to Ace Screen Helper: still reading them, what they
 * are, or why they can't be read and what to do next. "Checking" lasts only while a read is
 * on its way: a refused or failed read, computer use being off, or a closed channel each say so.
 */
export type PermissionsReading =
  | { state: "checking" }
  | { state: "known"; permissions: ScreenPermissions }
  | { state: "unavailable"; reason: string; next: string };

export function permissionsReading(input: {
  /** The screen channel is up. */
  connected: boolean;
  /** It was up and closed since. */
  closed: boolean;
  /** Computer use is on; undefined until the daemon said. */
  enabled: boolean | undefined;
  /** As last read. */
  permissions: ScreenPermissions | undefined;
  /** Why the last read failed; cleared by a read that succeeds. */
  problem: { code: string | undefined; message: string } | undefined;
}): PermissionsReading {
  const off = input.enabled === false;
  const turnOn = "Turn on Let agents use apps above.";
  if (input.problem) {
    const { title, hint } = screenProblem(input.problem.code, input.problem.message);
    return {
      state: "unavailable",
      reason: off || input.problem.code === "screen_disabled" ? "Computer use is off" : title,
      next:
        off || input.problem.code === "screen_disabled"
          ? turnOn
          : (hint ?? "If it keeps failing, restart ace on this Mac."),
    };
  }
  if (input.permissions) return { state: "known", permissions: input.permissions };
  if (!input.connected && input.closed)
    return {
      state: "unavailable",
      reason: "ace's screen channel is disconnected",
      next: "It reconnects once ace is back online.",
    };
  if (off) return { state: "unavailable", reason: "Computer use is off", next: turnOn };
  return { state: "checking" };
}

export { alwaysAsks, appName } from "./app-names.ts";
