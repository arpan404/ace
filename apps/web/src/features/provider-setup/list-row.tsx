import type { InstallAction, ProviderKind } from "@ace/protocol";
import type { ReadinessView } from "@ace/ui-core";
import { ArrowClockwiseIcon, CaretRightIcon, InfoIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { SignInButton } from "@/features/sign-in/index.ts";
import { useProviderConfiguration } from "@/lib/provider-configuration.ts";
import { cn } from "@/lib/cn.ts";
import { installPlan, listAction, unsupportedPlan, type ListAction } from "./list-action.ts";
import { useInstall } from "./use-install.ts";

export interface ProviderListRowProps {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  instance?: string | undefined;
  name: string;
  missing: boolean;
  readiness?: ReadinessView | undefined;
  updateAvailable?: boolean | undefined;
  latest?: string | undefined;
  /** The row stands for an installed provider (Settings' Installed group). */
  installed?: boolean | undefined;
  /** The provider's page (`/settings/providers/$provider`): the whole row opens it. */
  page?: string | undefined;
  /** Where Set up goes once an install finishes, when the row has no page of its own yet. */
  setUp?: string | undefined;
  version?: string | undefined;
  /** The line under the name: its state and accounts, or who publishes it. */
  sub?: ReactNode;
  /** Bumped by Update all: a row with an update waiting starts it. */
  updateAll?: number | undefined;
  /** Install or Update was pressed on this row. */
  onStart?: (() => void) | undefined;
}

const progressWidth = "w-16 sm:w-24";

/**
 * A provider as one row of a list: its mark, name and version, one line under the name, and at
 * the right the one action it needs or its installer's progress and outcome, in words. The
 * whole row opens the provider's page; the action stays on the list.
 */
export function ProviderListRow(props: ProviderListRowProps) {
  const { provider, name, missing } = props;
  const { controller, view } = useInstall(provider, props.acpAgentId);
  const [details, setDetails] = useState(false);
  const action = listAction({
    provider,
    name,
    view,
    missing,
    readiness: props.readiness,
    updateAvailable: props.updateAvailable,
    latest: props.latest,
    installed: props.installed,
  });
  const run = (kind: InstallAction) => {
    setDetails(false);
    props.onStart?.();
    void controller.install(kind);
  };
  // Update all: every row with an update waiting runs it through its own installer.
  const handled = useRef(props.updateAll ?? 0);
  const canUpdate =
    !missing &&
    action.kind !== "busy" &&
    (!!props.updateAvailable || props.readiness?.primary === "update");
  useEffect(() => {
    const signal = props.updateAll ?? 0;
    if (signal === handled.current) return;
    handled.current = signal;
    if (canUpdate) void controller.install("update");
  }, [props.updateAll, canUpdate, controller]);
  const plan = installPlan(view);
  const progress = view.kind === "progress" ? view.progress : undefined;
  const explained =
    action.kind === "failed" ||
    action.kind === "admin" ||
    (unsupportedPlan(view, missing) && plan?.action !== "uninstall");
  const note =
    action.kind === "failed"
      ? progress?.message ||
        (view.kind === "error"
          ? view.message
          : "The installer couldn't finish. Retry, or open Details to check what happened.")
      : action.kind === "admin"
        ? "This installer needs administrator approval. Open Details for the official command to run in your terminal."
        : explained
          ? plan?.message
          : undefined;
  return (
    <ListRowFrame
      provider={provider}
      acpAgentId={props.acpAgentId}
      name={name}
      page={props.page}
      version={props.version}
      sub={props.sub}
      right={
        <>
          <Action
            action={action}
            name={name}
            provider={provider}
            instance={props.instance}
            page={props.setUp ?? props.page}
            onRun={run}
            onCancel={() => void controller.cancel()}
          />
          {action.kind === "prerequisite" && (
            <IconButton
              icon={ArrowClockwiseIcon}
              size="sm"
              label={`Retry ${name} installation after installing prerequisites`}
              onClick={() => run(missing ? "install" : "update")}
            />
          )}
          {explained && (
            <IconButton
              size="sm"
              icon={InfoIcon}
              label={`${name} installation details`}
              aria-expanded={details}
              onClick={() => setDetails(!details)}
            />
          )}
        </>
      }
    >
      {(note || details) && (
        <div className="flex flex-col gap-2 pb-3 pl-8 text-xs text-muted-foreground">
          {note && <p>{note}</p>}
          {details && (
            <>
              {plan && (
                <a
                  href={plan.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="self-start underline"
                >
                  Official installer
                </a>
              )}
              {plan?.message && plan.message !== note && <p>{plan.message}</p>}
              {progress?.lines.length || plan?.commands.length ? (
                <pre
                  aria-label={`${name} redacted installation log`}
                  className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all"
                >
                  {(progress?.lines.length
                    ? progress.lines
                    : (plan?.commands.map((command) => command.display) ?? [])
                  ).join("\n")}
                </pre>
              ) : null}
            </>
          )}
        </div>
      )}
    </ListRowFrame>
  );
}

/**
 * The row's frame: mark, name (the link to its page, covering the row) and version, the line
 * under them, the controls at the right above the link, and what unfolds beneath.
 */
export function ListRowFrame(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  name: string;
  page?: string | undefined;
  version?: string | undefined;
  sub?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  const { name } = props;
  return (
    <div role="group" aria-label={name} className="flex min-w-0 flex-col">
      <div className="group/row relative flex min-h-(--setting-row-height) min-w-0 items-center gap-3 py-2">
        <ProviderIcon
          provider={props.provider}
          acpAgentId={props.acpAgentId}
          size={20}
          decorative
          className="shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            {props.page ? (
              <Link
                to="/settings/providers/$provider"
                params={{ provider: props.page }}
                aria-label={name}
                className="min-w-0 truncate text-ui font-medium text-foreground focus-ring after:absolute after:inset-0 after:content-['']"
              >
                {name}
              </Link>
            ) : (
              <span className="min-w-0 truncate text-ui font-medium text-foreground">{name}</span>
            )}
            {props.version && (
              <span className="shrink-0 font-mono text-xs text-subtle-foreground">
                {props.version}
              </span>
            )}
          </span>
          {props.sub && (
            <span className="truncate text-xs text-subtle-foreground">{props.sub}</span>
          )}
        </div>
        {/* Above the row's link, so its controls take their own clicks. */}
        <div className="relative z-10 flex shrink-0 items-center gap-2">{props.right}</div>
        {props.page && (
          <CaretRightIcon
            aria-hidden
            size={14}
            className="shrink-0 text-subtle-foreground transition-colors duration-(--motion-fast) group-hover/row:text-foreground"
          />
        )}
      </div>
      {props.children}
    </div>
  );
}

/** The row's right side: progress or an outcome in words, or the one action. */
function Action(props: {
  action: ListAction;
  name: string;
  provider: ProviderKind;
  instance: string | undefined;
  page: string | undefined;
  onRun(kind: InstallAction): void;
  onCancel(): void;
}) {
  const { action, name } = props;
  switch (action.kind) {
    case "busy":
      return (
        <>
          <span role="status" className="text-xs text-muted-foreground">
            {action.words}
          </span>
          <InstallProgress
            label={`${name} installation progress`}
            value={action.value}
            words={action.words}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Cancel ${name} installation`}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </>
      );
    case "failed":
      return (
        <>
          <span role="alert" className="text-xs text-status-failed">
            {action.words}
          </span>
          <Button size="sm" variant="secondary" onClick={() => props.onRun(action.retry)}>
            Retry
          </Button>
        </>
      );
    case "admin":
      return <span className="text-xs text-status-needs-you">Approval needed</span>;
    case "done":
      return (
        <>
          <span role="status" className="text-xs text-status-done">
            {action.words}
          </span>
          {action.words === "Installed" && props.page && (
            <Link
              to="/settings/providers/$provider"
              params={{ provider: props.page }}
              aria-label={`Set up ${name}`}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              Set up
            </Link>
          )}
        </>
      );
    case "manual":
    case "prerequisite":
      return (
        <a
          href={action.href}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: "sm", variant: "secondary" })}
        >
          {action.kind === "manual" ? action.label : `Get ${action.name}`}
        </a>
      );
    case "turn-on":
      return <TurnOn provider={props.provider} name={name} />;
    case "run":
      return (
        <>
          {action.cancelled && <span className="text-xs text-muted-foreground">Cancelled</span>}
          <Button
            size="sm"
            variant="secondary"
            aria-label={action.to ? `${action.label} to ${action.to}` : undefined}
            onClick={() => props.onRun(action.action)}
          >
            {/* One text run, so the words space as words; the version where there's room. */}
            <span>
              {action.label}
              {action.to && <span className="hidden sm:inline"> to {action.to}</span>}
            </span>
          </Button>
        </>
      );
    case "sign-in":
      return (
        <SignInButton
          variant="secondary"
          label={`Sign in to ${name}`}
          target={{ provider: props.provider, instance: props.instance, name }}
        >
          {action.label}
        </SignInButton>
      );
    case "none":
      return null;
  }
}

function TurnOn(props: { provider: ProviderKind; name: string }) {
  const preferences = useProviderConfiguration(props.provider);
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`Turn on ${props.name}`}
      disabled={preferences.disabled}
      onClick={() => void preferences.update((row) => ({ ...row, enabled: true }))}
    >
      Turn on
    </Button>
  );
}

/**
 * A thin bar: filled to the job's share once it reports one, else the one sweep the app allows
 * for work that can't say how far along it is (DESIGN.md §2, motion).
 */
function InstallProgress(props: { label: string; value: number | undefined; words: string }) {
  return (
    <span
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value}
      aria-valuetext={props.value === undefined ? props.words : `${props.value}%`}
      className={cn("relative block h-1 overflow-hidden rounded-full bg-input", progressWidth)}
    >
      {props.value === undefined ? (
        <span className="fx-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-foreground/70" />
      ) : (
        <span
          className="absolute inset-0 origin-left rounded-full bg-foreground/70 transition-transform duration-(--motion-base) ease-smooth"
          style={{ transform: `scaleX(${props.value / 100})` }}
        />
      )}
    </span>
  );
}
