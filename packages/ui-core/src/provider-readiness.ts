import type { ModelInstanceStatus, ModelSource, ProviderKind, ProviderStatus } from "@ace/protocol";
import { providerNames } from "./providers.ts";
import { modelsAvailableWithoutAuth } from "@ace/models/availability";

/*
 * A provider's readiness (`providers.request { operation: "readiness" }`) in words, with what
 * the person can do about it. Settings, first-run setup and the sign-in dialog all say it the
 * same way. A CLI that doesn't report its sign-in is neither ready nor a problem until its
 * models say which; "Needs attention" is kept for real problems (an expired sign-in, a limit,
 * a failed probe). A CLI that reaches models through upstream providers (OpenCode, Pi) is as
 * ready as its upstreams: ready while one is connected, signed out while none is. Pure.
 */

/** CLIs that sign in per upstream provider: their own sign-in means connecting one. */
const viaUpstreams: ReadonlySet<ProviderKind> = new Set(["opencode", "pi"]);

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

/** The colour a status is drawn in: ready (green), needs the person (amber), a problem (red). */
export type ReadinessTone = "ready" | "action" | "problem" | "idle";

export interface ReadinessView {
  state: ReadinessState;
  /** Usable for a new thread now. */
  ready: boolean;
  /** The status in a word or two: "Ready", "Sign in needed", "Needs attention", "Not installed". */
  label: string;
  /**
   * The one line a list shows: "Signed in as ada@example.com", "4 services connected", "Ready",
   * "Sign in needed", "Needs attention".
   */
  summary: string;
  /** Why it needs attention or how to get it, in the daemon's safe words; for its own page. */
  detail?: string | undefined;
  tone: ReadinessTone;
  /** The one prominent action: Sign in while signed out, Reconnect while it needs attention. */
  primary?: "sign_in" | "reconnect" | undefined;
  /** Quieter actions, for the provider's own page. */
  more: readonly ReadinessAction[];
  /** Signing in connects a service (OpenCode, Pi): the CLI's choices list them. */
  upstreams?: boolean | undefined;
  /** Who the CLI says is signed in, when it says. */
  account?: string | undefined;
  /** The CLI doesn't report its sign-in; ace goes by whether it lists models. */
  unreported?: boolean | undefined;
}

/** What the model catalog says about a provider: whether it lists models, and an auth error. */
export interface CatalogSignal {
  withoutAuth?: boolean | undefined;
  models: boolean;
  /** The catalog's own words for an expired or refused sign-in. */
  problem?: string | undefined;
  /** Upstream providers (not local runtimes) with models and no error: OpenCode Go, OpenAI… */
  connected: number;
}

/** A provider's catalog signal, from the catalog's models and per-account statuses. */
export function catalogSignal(
  models: readonly {
    provider: ProviderKind;
    instance: string;
    free?: boolean | undefined;
    source?: ModelSource | undefined;
  }[],
  instances: readonly ModelInstanceStatus[],
  provider: ProviderKind,
  instance?: string,
): CatalogSignal {
  const own = instances.filter(
    (status) => status.provider === provider && (!instance || status.instance === instance),
  );
  models = models.filter(
    (model) => model.provider === provider && (!instance || model.instance === instance),
  );
  const problem = own.find((status) => status.errorDetail?.code === "auth_expired")?.errorDetail
    ?.message;
  const failing = new Set(
    own.flatMap((status) =>
      (status.sources ?? []).flatMap((entry) => (entry.error ? [entry.source.id] : [])),
    ),
  );
  const connected = new Set<string>();
  for (const model of models)
    if (
      model.provider === provider &&
      model.source &&
      model.source.kind !== "local" &&
      model.source.kind !== "account" &&
      model.source.requiresAuth !== false &&
      !failing.has(model.source.id)
    )
      connected.add(model.source.id);
  return {
    models: models.some((model) => model.provider === provider),
    withoutAuth: modelsAvailableWithoutAuth(
      models.filter((model) => model.provider === provider),
      own,
    ),
    problem,
    connected: connected.size,
  };
}

/** A real problem (an expired sign-in, a limit, a failed probe): Reconnect fixes it. */
const attention = (detail: string | undefined): ReadinessView => ({
  state: "attention",
  ready: false,
  label: "Needs attention",
  summary: "Needs attention",
  detail,
  tone: "problem",
  primary: "reconnect",
  more: ["sign_out"],
});

const signedOut = (detail?: string, upstreams?: boolean): ReadinessView => ({
  state: "signed_out",
  ready: false,
  label: "Sign in needed",
  summary: "Sign in needed",
  detail,
  tone: "action",
  primary: "sign_in",
  more: [],
  ...(upstreams ? { upstreams } : {}),
});

const quiet = (state: ReadinessState, label: string, detail?: string): ReadinessView => ({
  state,
  ready: false,
  label,
  summary: label,
  detail,
  tone: "idle",
  more: [],
});

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * How one provider reads and what it offers. `catalog` (once the model catalog has loaded)
 * decides whether a CLI that doesn't report its sign-in is ready, and turns a catalog auth
 * error into "Needs attention". Until it has loaded, such a CLI reads "Checking…" rather than
 * flicker from unconfirmed to ready.
 */
export function readinessView(row: ProviderStatus, catalog?: CatalogSignal): ReadinessView {
  const name = providerNames[row.provider];
  if (row.installed === false) return quiet("not_installed", "Not installed", row.installHint);
  if (row.enabled === false) return quiet("off", "Turned off");
  const readiness =
    row.readiness ?? (row.auth === "logged_out" ? "installed_signed_out" : "signed_in");
  if (
    row.provider === "opencode" &&
    row.installed === true &&
    !row.error &&
    (row.modelsAvailable || catalog?.withoutAuth)
  )
    return {
      state: "ready",
      ready: true,
      label: "Ready",
      summary: "Ready",
      tone: "ready",
      more: row.auth === "logged_out" ? ["sign_in"] : ["reconnect", "sign_out"],
      upstreams: true,
    };
  if (
    viaUpstreams.has(row.provider) &&
    catalog &&
    row.installed === true &&
    !row.error &&
    (readiness === "signed_in" ||
      readiness === "installed_signed_out" ||
      readiness === "needs_attention")
  )
    return catalog.connected
      ? {
          state: "ready",
          ready: true,
          label: "Ready",
          summary: `${plural(catalog.connected, "service")} connected`,
          tone: "ready",
          more: ["reconnect", "sign_out"],
          upstreams: true,
          ...(row.auth === "unknown" ? { unreported: true } : {}),
        }
      : signedOut(`Connect a service to ${name}, such as GitHub Copilot or OpenAI.`, true);
  switch (readiness) {
    case "not_installed":
      return quiet("not_installed", "Not installed", row.installHint);
    case "not_configured":
      return signedOut(`Sign in to ${name} to use it.`);
    case "installed_signed_out":
      return signedOut();
    case "needs_attention":
      if (row.installed === null) return quiet("checking", "Checking…");
      if (row.auth === "logged_out") return signedOut(row.authDetail ?? row.error);
      return attention(row.authDetail ?? row.error);
    case "signed_in": {
      if (catalog?.problem) return attention(catalog.problem);
      const ready = (summary: string, extra: Partial<ReadinessView> = {}): ReadinessView => ({
        state: "ready",
        ready: true,
        label: "Ready",
        summary,
        tone: "ready",
        more: ["reconnect", "sign_out"],
        ...extra,
      });
      if (row.auth === "unknown") {
        if (!catalog) return { ...quiet("checking", "Checking…"), unreported: true };
        return catalog.models
          ? ready("Ready", { unreported: true })
          : {
              ...quiet(
                "unconfirmed",
                "Installed",
                `${name} doesn't report who is signed in, and it lists no models yet.`,
              ),
              more: ["reconnect", "sign_out"],
              unreported: true,
            };
      }
      return row.accountLabel
        ? ready(`Signed in as ${row.accountLabel}`, { account: row.accountLabel })
        : ready("Signed in");
    }
  }
}
