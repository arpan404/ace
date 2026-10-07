import type { BrowserState } from "@ace/protocol";
import type { BrowserBackend } from "./backend.ts";

export type BackendPreference = "auto" | "embedded" | "headless";

/**
 * Backends to try, in order, for a thread's new session (ADR 0069). People and agents get the
 * same choice: `auto` prefers the desktop's native view whenever a desktop backend is
 * registered and falls back to ace's headless Chromium when the desktop cannot host the view
 * (no window, its session limit, a failed open). An explicit `embedded` never falls back.
 */
export function backendCandidates(
  preference: BackendPreference,
  embeddedAvailable: boolean,
): BrowserBackend["kind"][] {
  if (preference === "headless") return ["headless"];
  if (preference === "embedded") {
    if (!embeddedAvailable) throw new Error("Desktop browser backend unavailable");
    return ["embedded"];
  }
  return embeddedAvailable ? ["embedded", "headless"] : ["headless"];
}

/**
 * Agent work resumes headlessly on a session paused by the loss of its desktop view, unless a
 * person holds the page (shared or private): their lease keeps it paused until they act.
 */
export function agentResumes(state: BrowserState): boolean {
  return (
    !state.closed &&
    state.status === "paused" &&
    state.controller !== "human" &&
    // A paused page reports no controller; a person's retained ownership shows as its owner.
    state.owner === undefined &&
    state.takeoverMode !== "private"
  );
}
