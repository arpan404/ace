import type { ProviderStatus } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/*
 * A provider's readiness (`providers.request { operation: "readiness" }`) in words, with the
 * one action that moves it on. Settings, first-run setup and the sign-in dialog all say it the
 * same way. Pure.
 */

/** What the person can do next: sign in, sign out, sign in again, or install the CLI. */
export type ReadinessAction = "sign_in" | "sign_out" | "reconnect" | "install";

export interface ReadinessView {
  /** Signed in and usable for a new thread. */
  ready: boolean;
  /** "Signed in as ada@example.com", "Not signed in", "Not installed". */
  label: string;
  /** Why it needs attention, or how to install it. */
  detail?: string | undefined;
  action?: ReadinessAction | undefined;
}

/** How one readiness row reads, and the action it offers. */
export function readinessView(row: ProviderStatus): ReadinessView {
  const name = providerNames[row.provider];
  const readiness =
    row.readiness ??
    (row.installed === false
      ? "not_installed"
      : row.auth === "logged_in"
        ? "signed_in"
        : row.auth === "logged_out"
          ? "installed_signed_out"
          : "needs_attention");
  switch (readiness) {
    case "signed_in":
      return {
        ready: true,
        label: row.accountLabel ? `Signed in as ${row.accountLabel}` : "Signed in",
        action: "sign_out",
      };
    case "installed_signed_out":
      return { ready: false, label: "Not signed in", action: "sign_in" };
    case "not_configured":
      return row.enabled === false
        ? { ready: false, label: "Turned off" }
        : { ready: false, label: `Sign in to ${name} to use it`, action: "sign_in" };
    case "not_installed":
      return { ready: false, label: "Not installed", detail: row.installHint, action: "install" };
    case "needs_attention":
      return {
        ready: false,
        label: row.auth === "logged_out" ? "Not signed in" : "Needs attention",
        detail:
          row.authDetail ??
          row.error ??
          (row.auth === "unknown" ? "ace couldn't confirm the sign-in." : undefined),
        action:
          row.installed !== true ? undefined : row.auth === "logged_out" ? "sign_in" : "reconnect",
      };
  }
}
