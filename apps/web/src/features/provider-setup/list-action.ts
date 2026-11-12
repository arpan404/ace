import type { InstallAction, ProviderInstallPlan, ProviderKind } from "@ace/protocol";
import type { InstallView, ReadinessView } from "@ace/ui-core";

/**
 * The one thing a provider's row in a list shows at its right: an installer's progress or
 * outcome in words, or the single action the provider needs. Derived, never stored.
 */
export type ListAction =
  | { kind: "busy"; words: string; value: number | undefined }
  | { kind: "failed"; words: string; retry: InstallAction }
  | { kind: "admin" }
  | { kind: "done"; words: "Installed" | "Updated" }
  | { kind: "manual"; href: string; label: string }
  | { kind: "prerequisite"; href: string; name: string }
  | { kind: "turn-on" }
  | { kind: "run"; action: InstallAction; label: string; cancelled: boolean }
  | { kind: "sign-in"; label: string }
  | { kind: "none" };

export interface ListActionInput {
  provider: ProviderKind;
  name: string;
  view: InstallView;
  missing: boolean;
  readiness?: ReadinessView | undefined;
  updateAvailable?: boolean | undefined;
  /** The newer version an update brings, when known: "Update to 0.161.0". */
  latest?: string | undefined;
  /**
   * The row stands for an installed provider: a finished install from before (the job outlives
   * the page) isn't news there, so it shows the provider's own action instead.
   */
  installed?: boolean | undefined;
}

const failedNames: Record<InstallAction, string> = {
  install: "Install failed",
  update: "Update failed",
  uninstall: "Removal failed",
};

const live = ["planning", "running", "verifying"];

/** The installer's plan, from a plan reply or the job it started. */
export function installPlan(view: InstallView): ProviderInstallPlan | undefined {
  return view.kind === "plan"
    ? view.plan
    : view.kind === "progress"
      ? view.progress.plan
      : undefined;
}

/** A plan this computer can't run itself (a download page, a missing prerequisite). */
export function unsupportedPlan(view: InstallView, missing: boolean): boolean {
  const plan = installPlan(view);
  return (
    !!plan &&
    plan.status !== "ready" &&
    plan.status !== "sign_in" &&
    (missing || plan.action !== "install")
  );
}

export function listAction(input: ListActionInput): ListAction {
  const { view, missing, provider, readiness } = input;
  const progress = view.kind === "progress" ? view.progress : undefined;
  const plan = installPlan(view);
  const action: InstallAction = missing ? "install" : "update";
  if (view.kind === "loading" || (progress && live.includes(progress.state))) {
    const words =
      progress?.state === "running"
        ? progress.action === "update"
          ? "Updating…"
          : progress.action === "uninstall"
            ? "Removing…"
            : "Installing…"
        : progress?.state === "verifying"
          ? "Checking…"
          : "Preparing…";
    // Steps are the plan's commands, then the check: a share once a command has run.
    const steps = (progress?.plan?.commands.length ?? 0) + 1;
    const value =
      progress && progress.state !== "planning" && steps > 1 && progress.step > 0
        ? Math.round((100 * Math.min(progress.step, steps)) / steps)
        : undefined;
    return { kind: "busy", words, value };
  }
  if (
    progress?.state === "needs_admin" ||
    (view.kind === "plan" && view.plan.needsAdmin && view.plan.action !== "uninstall")
  )
    return { kind: "admin" };
  if (plan && unsupportedPlan(view, missing) && plan.action !== "uninstall") {
    if (plan.status === "manual")
      return {
        kind: "manual",
        href: plan.sourceUrl,
        label: plan.downloadOnly ? `Get ${input.name}` : "Manage installation",
      };
    if (plan.prerequisite)
      return {
        kind: "prerequisite",
        href: plan.prerequisite.sourceUrl,
        name: plan.prerequisite.name,
      };
  }
  if (view.kind === "error" || progress?.state === "failed")
    return {
      kind: "failed",
      words: failedNames[progress?.action ?? action],
      retry: progress && progress.action !== "uninstall" ? progress.action : action,
    };
  if (progress?.state === "succeeded") {
    if (progress.action === "update") return { kind: "done", words: "Updated" };
    if (progress.action === "install" && !input.installed)
      return { kind: "done", words: "Installed" };
  }
  // Turned off in Settings: Turn on is the one action. Sign-in is refused until then.
  if (!missing && readiness?.state === "off") return { kind: "turn-on" };
  // Older than ace supports: Update is the one action, whatever the sign-in says.
  const needsUpdate = !missing && readiness?.primary === "update";
  const needsSignIn =
    !needsUpdate &&
    ((provider === "cursor" && missing) ||
      (!missing &&
        (provider === "acp" || provider === "antigravity") &&
        (!readiness || readiness.state === "unconfirmed")) ||
      plan?.status === "sign_in" ||
      (!missing && !!readiness?.primary));
  const update = needsUpdate || (!!input.updateAvailable && !needsSignIn);
  const cancelled = progress?.state === "cancelled";
  if (
    cancelled ||
    (missing && provider !== "cursor" && plan?.status !== "sign_in") ||
    (!missing && update)
  )
    return {
      kind: "run",
      action,
      cancelled,
      label:
        action === "install" ? "Install" : input.latest ? `Update to ${input.latest}` : "Update",
    };
  if (needsSignIn)
    return { kind: "sign-in", label: readiness?.primary ? "Sign in again" : "Sign in" };
  return { kind: "none" };
}
