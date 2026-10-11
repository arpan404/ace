import type { ProviderKind, ProviderInstallProgress } from "@ace/protocol";
import type { ReadinessView } from "@ace/ui-core";
import { ArrowClockwiseIcon, InfoIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { StatusLine } from "@/components/provider-tile.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SignInButton } from "@/features/sign-in/index.ts";
import { useInstall } from "./use-install.ts";

const progressNames: Record<ProviderInstallProgress["state"], string> = {
  planning: "Preparing…",
  running: "Installing…",
  verifying: "Checking…",
  succeeded: "Installed",
  failed: "Install failed",
  cancelled: "Cancelled",
  needs_admin: "Approval needed",
};

/** All provider surfaces share the same action, installation recovery and login flow. */
export function ProviderSetupRow(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  instance?: string | undefined;
  name: string;
  missing: boolean;
  view?: ReadinessView | undefined;
  updateAvailable?: boolean | undefined;
  title?: ReactNode;
  secondary?: ReactNode;
  manage?: boolean;
}) {
  const { provider, name, missing } = props;
  const { controller, view } = useInstall(provider, props.acpAgentId);
  const [details, setDetails] = useState(false);
  const progress = view.kind === "progress" ? view.progress : undefined;
  const plan = view.kind === "plan" ? view.plan : progress?.plan;
  const busy =
    view.kind === "loading" ||
    (!!progress && ["planning", "running", "verifying"].includes(progress.state));
  const failed = view.kind === "error" || progress?.state === "failed";
  const action = missing ? "install" : "update";
  const unsupported =
    plan &&
    plan.status !== "ready" &&
    plan.status !== "sign_in" &&
    (missing || plan.action !== "install");
  const needsSignIn =
    (provider === "cursor" && missing) ||
    plan?.status === "sign_in" ||
    (!missing && (props.view?.primary || (provider === "acp" && !props.view?.ready)));
  const updateAvailable = props.updateAvailable && !needsSignIn;
  const status = busy
    ? progress?.state === "running"
      ? progress.action === "update"
        ? "Updating…"
        : progress.action === "uninstall"
          ? "Removing…"
          : "Installing…"
      : progressNames[progress?.state ?? "planning"]
    : failed
      ? "Install failed"
      : progress?.state === "succeeded"
        ? progress.action === "uninstall"
          ? "Removed"
          : progressNames.succeeded
        : progress?.state === "cancelled"
          ? "Cancelled"
          : undefined;
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex h-9 min-w-0 items-center gap-2 text-sm">
        <ProviderIcon provider={provider} acpAgentId={props.acpAgentId} size={16} decorative />
        <span className="min-w-0 flex-1 truncate font-medium">{props.title ?? name}</span>
        {status ? (
          <span role={failed ? "alert" : "status"}>
            <StatusLabel
              tone={
                failed
                  ? "failed"
                  : busy
                    ? "working"
                    : progress?.state === "succeeded"
                      ? "done"
                      : "idle"
              }
              label={status}
            />
          </span>
        ) : missing ? (
          <StatusLabel tone="idle" label="Not installed" />
        ) : updateAvailable && (!props.view || props.view.ready) ? (
          <StatusLabel tone="needs-you" label="Update available" />
        ) : props.view ? (
          <StatusLine
            tone={props.view.ready ? "ready" : props.view.tone}
            text={props.view.ready ? "Ready" : props.view.summary}
          />
        ) : (
          <StatusLabel tone="idle" label="Checking…" />
        )}
        {busy ? (
          <IconButton
            size="sm"
            icon={XIcon}
            label={`Cancel ${name} installation`}
            onClick={() => void controller.cancel()}
          />
        ) : unsupported && plan.action !== "uninstall" && plan.status === "manual" ? (
          <a
            href={plan.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: "sm", variant: "secondary" })}
          >
            {plan.downloadOnly ? `Get ${name}` : "Manage installation"}
          </a>
        ) : unsupported && plan.prerequisite && plan.action !== "uninstall" ? (
          <a
            href={plan.prerequisite.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: "sm", variant: "secondary" })}
          >
            Get {plan.prerequisite.name}
          </a>
        ) : failed ||
          progress?.state === "cancelled" ||
          (missing && provider !== "cursor" && plan?.status !== "sign_in") ||
          updateAvailable ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDetails(false);
              void controller.install(action);
            }}
          >
            {failed ? "Retry" : action === "install" ? "Install" : "Update"}
          </Button>
        ) : needsSignIn ? (
          <SignInButton
            variant="secondary"
            label={`Sign in to ${name}`}
            target={{ provider, instance: props.instance, name }}
          >
            Sign in
          </SignInButton>
        ) : null}
        {(plan || progress || view.kind === "error") && !busy && (
          <IconButton
            size="sm"
            icon={InfoIcon}
            label={`${name} installation details`}
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          />
        )}
        {unsupported && plan.prerequisite && plan.action !== "uninstall" && (
          <IconButton
            icon={ArrowClockwiseIcon}
            size="sm"
            label={`Retry ${name} installation after installing prerequisites`}
            onClick={() => void controller.install(action)}
          />
        )}
        {props.manage && !missing && provider !== "cursor" && provider !== "acp" && !busy && (
          <IconButton
            size="sm"
            icon={TrashIcon}
            label={`Remove ${name}${name.endsWith("CLI") ? "" : " CLI"}`}
            onClick={() => {
              setDetails(true);
              void controller.plan("uninstall");
            }}
          />
        )}
        {props.secondary}
      </div>
      {busy && (
        <ProgressBar label={`${name} installation progress`} value={undefined} valueText={status} />
      )}
      {(failed || plan?.needsAdmin || unsupported) && (
        <p className="py-1 text-sm text-muted-foreground">
          {failed
            ? "The installer couldn't finish. Retry, or open Details to check what happened."
            : plan?.needsAdmin
              ? "This installer needs administrator approval. Open Details for the official command to run in your terminal."
              : plan?.message}
        </p>
      )}
      {details && (
        <div className="flex flex-col gap-2 py-2 text-sm text-muted-foreground">
          <span>Details</span>
          {plan && (
            <a href={plan.sourceUrl} target="_blank" rel="noreferrer" className="underline">
              Official installer
            </a>
          )}
          {plan?.action === "uninstall" &&
            plan.status === "ready" &&
            !plan.needsAdmin &&
            plan.method && (
              <>
                <p>
                  Remove {name}'s CLI from this computer? Sign-ins and conversations stay saved.
                </p>
                <Button
                  size="sm"
                  variant="danger"
                  className="self-start"
                  onClick={() => {
                    if (plan.method) void controller.run("uninstall", plan.method);
                  }}
                >
                  Remove CLI
                </Button>
              </>
            )}
          {plan?.message && <p>{plan.message}</p>}
          {view.kind === "error" && <p>{view.message}</p>}
          {progress?.lines.length || plan?.commands.length ? (
            <pre
              aria-label={`${name} redacted installation log`}
              className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all"
            >
              {(progress?.lines ?? plan?.commands.map((command) => command.display) ?? []).join(
                "\n",
              )}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
}
