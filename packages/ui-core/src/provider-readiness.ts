import type { ModelInstanceStatus, ProviderKind, ProviderStatus } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/*
 * A provider's readiness (`providers.request { operation: "readiness" }`) in words, with what
 * the person can do about it. Settings, first-run setup and the sign-in dialog all say it the
 * same way. A CLI that doesn't report its sign-in is neither ready nor a problem until its
 * models say which; "Needs attention" is kept for real problems (an expired sign-in, a limit,
 * a failed probe). Pure.
 */

/** Something the person can do: sign in, sign in again, or sign out. */
export type ReadinessAction = "sign_in" | "reconnect" | "sign_out";

export type ReadinessState =
  | "ready"
  /** Installed, sign-in not reported by the CLI, and no models (yet) to show it works. */
  | "unconfirmed"
  | "signed_out"
  | "attention"
  | "checking"
  | "not_installed"
  | "off";

export interface ReadinessView {
  state: ReadinessState;
  /** Usable for a new thread now. */
  ready: boolean;
  /** "Signed in as ada@example.com", "Ready", "Not signed in", "Needs attention". */
  label: string;
  /** Quiet secondary text: why it needs attention, how to install it, or what's unreported. */
  detail?: string | undefined;
  /** The one prominent action: Sign in while signed out, Reconnect while it needs attention. */
  primary?: "sign_in" | "reconnect" | undefined;
  /** Quieter actions, for an overflow menu. */
  more: readonly ReadinessAction[];
}

/** What the model catalog says about a provider: whether it lists models, and an auth error. */
export interface CatalogSignal {
  models: boolean;
  /** The catalog's own words for an expired or refused sign-in. */
  problem?: string | undefined;
}

/** A provider's catalog signal, from the catalog's models and per-account statuses. */
export function catalogSignal(
  models: readonly { provider: ProviderKind }[],
  instances: readonly ModelInstanceStatus[],
  provider: ProviderKind,
): CatalogSignal {
  const problem = instances.find(
    (status) => status.provider === provider && status.errorDetail?.code === "auth_expired",
  )?.errorDetail?.message;
  return { models: models.some((model) => model.provider === provider), problem };
}

/** A real problem (an expired sign-in, a limit, a failed probe): Reconnect fixes it. */
const attention = (detail: string | undefined): ReadinessView => ({
  state: "attention",
  ready: false,
  label: "Needs attention",
  detail,
  primary: "reconnect",
  more: ["sign_out"],
});

const unreported = "Sign-in not reported by this CLI";

/**
 * How one readiness row reads and what it offers. `catalog` (once the model catalog has loaded)
 * decides whether a CLI that doesn't report its sign-in is ready, and turns a catalog auth
 * error into "Needs attention".
 */
export function readinessView(row: ProviderStatus, catalog?: CatalogSignal): ReadinessView {
  const name = providerNames[row.provider];
  const readiness =
    row.readiness ??
    (row.installed === false
      ? "not_installed"
      : row.auth === "logged_out"
        ? "installed_signed_out"
        : "signed_in");
  switch (readiness) {
    case "not_installed":
      return {
        state: "not_installed",
        ready: false,
        label: "Not installed",
        detail: row.installHint,
        more: [],
      };
    case "not_configured":
      return row.enabled === false
        ? { state: "off", ready: false, label: "Turned off", more: [] }
        : {
            state: "signed_out",
            ready: false,
            label: `Sign in to ${name} to use it`,
            primary: "sign_in",
            more: [],
          };
    case "installed_signed_out":
      return {
        state: "signed_out",
        ready: false,
        label: "Not signed in",
        primary: "sign_in",
        more: [],
      };
    case "needs_attention":
      if (row.installed === null)
        return { state: "checking", ready: false, label: "Checking…", more: [] };
      if (row.auth === "logged_out")
        return {
          state: "signed_out",
          ready: false,
          label: "Not signed in",
          detail: row.authDetail ?? row.error,
          primary: "sign_in",
          more: [],
        };
      return attention(row.authDetail ?? row.error);
    case "signed_in":
      if (catalog?.problem) return attention(catalog.problem);
      if (row.auth === "unknown")
        return catalog?.models
          ? {
              state: "ready",
              ready: true,
              label: "Ready",
              detail: unreported,
              more: ["reconnect", "sign_out"],
            }
          : {
              state: "unconfirmed",
              ready: false,
              label: unreported,
              detail: catalog ? "It lists no models yet." : undefined,
              more: ["reconnect", "sign_out"],
            };
      return {
        state: "ready",
        ready: true,
        label: row.accountLabel ? `Signed in as ${row.accountLabel}` : "Signed in",
        more: ["reconnect", "sign_out"],
      };
  }
}
