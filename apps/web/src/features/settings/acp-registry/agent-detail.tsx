import type { RegistryAgent, RegistryInstallation, RegistryInstallPlan } from "@ace/protocol";
import { ArrowSquareOutIcon, CaretLeftIcon, CheckCircleIcon } from "@phosphor-icons/react";
import {
  installPhase,
  planFacts,
  registryPublisher,
  registryStanding,
} from "@ace/ui-core/acp-registry";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formatBytes } from "@/components/format-bytes.ts";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { AgentIcon } from "./agent-icon.tsx";
import { SetupSteps } from "./setup-steps.tsx";
import { useInstall, useInstallPlan } from "./use-registry.ts";

const newIntentId = () => crypto.randomUUID();

/**
 * One registry entry: what it is, then the install plan in plain words (what, from where,
 * which runtime, how it's checked, the exact command). Install asks once more before it sends
 * the intent with the plan's digest; then progress with Cancel, and the result with how to
 * set the agent up.
 */
export function AgentDetail(props: {
  agent: RegistryAgent;
  installations: readonly RegistryInstallation[];
  onBack?: (() => void) | undefined;
  onClose(): void;
}) {
  const { agent } = props;
  const standing = registryStanding(agent, props.installations);
  const plan = useInstallPlan(agent);
  const install = useInstall(newIntentId);
  const { state } = install;
  const publisher = registryPublisher(agent.authors);
  const installing = state.step === "installing";
  const canInstall =
    standing.kind === "available" || (standing.kind === "installed" && !!standing.update);
  return (
    <>
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
        {props.onBack && (
          <IconButton
            icon={CaretLeftIcon}
            label="Back to the registry"
            size="sm"
            disabled={installing}
            onClick={props.onBack}
          />
        )}
        <AgentIcon agent={agent} />
        <h2 className="min-w-0 flex-1 truncate text-base font-medium">{agent.name}</h2>
        <span className="shrink-0 font-mono text-xs text-subtle-foreground">{agent.version}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-col gap-1">
          <p>{agent.description}</p>
          <p className="text-sm text-muted-foreground">
            {[publisher, agent.license].filter(Boolean).join(" · ")}
            {agent.homepage && (
              <>
                {" · "}
                <a
                  href={agent.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-link hover:underline"
                >
                  Website
                  <ArrowSquareOutIcon aria-hidden />
                </a>
              </>
            )}
          </p>
        </div>
        <Outcome state={state} name={agent.name} loginHint={agent.loginHint} />
        {standing.kind === "unavailable" ? (
          <p className="text-muted-foreground">
            {standing.reason}. ace can't install {agent.name} here.
          </p>
        ) : standing.kind === "installed" && !standing.update && state.step !== "installed" ? (
          <>
            <p className="inline-flex items-center gap-1.5">
              <CheckCircleIcon aria-hidden className="text-status-done" />
              {agent.name} {standing.version} is installed.
            </p>
            <SetupSteps name={agent.name} loginHint={agent.loginHint} />
          </>
        ) : plan.isPending ? (
          <p className="inline-flex items-center gap-2 text-muted-foreground">
            <Spinner label="Preparing the install plan" /> Preparing the install plan…
          </p>
        ) : plan.isError ? (
          <p role="alert" className="text-muted-foreground">
            {plan.error.message}{" "}
            <Button variant="link" onClick={() => void plan.refetch()}>
              Try again
            </Button>
          </p>
        ) : (
          state.step !== "installed" && <Plan plan={plan.data} name={agent.name} />
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t px-3.5 py-2">
        <Footer
          state={state}
          name={agent.name}
          plan={canInstall ? plan.data : undefined}
          update={standing.kind === "installed" ? standing.update : undefined}
          install={install}
          onRetry={() => {
            // A plan can expire (the registry changed meanwhile): review a fresh one.
            void plan.refetch();
            install.confirm();
          }}
          onClose={props.onClose}
        />
      </div>
    </>
  );
}

/** The plan as a short list of facts; paths and the command are monospaced and selectable. */
function Plan(props: { plan: RegistryInstallPlan; name: string }) {
  const facts = planFacts(props.plan, props.name);
  const rows = (items: typeof facts) =>
    items.map((fact) => (
      <div key={fact.label} className="flex flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">{fact.label}</dt>
        <dd className={fact.code ? "font-mono text-xs break-all select-text" : undefined}>
          {fact.value}
        </dd>
      </div>
    ));
  return (
    <div className="flex flex-col gap-3">
      <dl aria-label="Install plan" className="flex flex-col gap-2">
        {rows(facts.filter((fact) => !fact.code))}
      </dl>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground focus-ring">
          Details
        </summary>
        <dl className="mt-2 flex flex-col gap-2">{rows(facts.filter((fact) => fact.code))}</dl>
      </details>
    </div>
  );
}

/** What happened: installing (with its step and bytes), installed, or why it didn't. */
function Outcome(props: {
  state: ReturnType<typeof useInstall>["state"];
  name: string;
  loginHint: string;
}) {
  const { state } = props;
  if (state.step === "failed")
    return (
      <p role="alert" className="text-destructive">
        {state.message}
      </p>
    );
  if (state.step !== "installed") return null;
  return (
    <div role="status" className="flex flex-col gap-1.5">
      <p className="inline-flex items-center gap-1.5 font-medium">
        <CheckCircleIcon aria-hidden weight="fill" className="text-status-done" />
        {props.name} {state.installation.version} is installed
      </p>
      <SetupSteps name={props.name} loginHint={props.loginHint} />
    </div>
  );
}

function Footer(props: {
  state: ReturnType<typeof useInstall>["state"];
  name: string;
  plan: RegistryInstallPlan | undefined;
  update: string | undefined;
  install: ReturnType<typeof useInstall>;
  onRetry(): void;
  onClose(): void;
}): ReactNode {
  const { state, plan, install } = props;
  const label = props.update ? `Update to ${props.update}` : "Install";
  if (state.step === "installing")
    return (
      <>
        <span role="status" className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm">
          <Spinner label="Installing" />
          {state.cancelling
            ? "Cancelling…"
            : install.progress
              ? `${installPhase(install.progress, plan?.runtime ?? "binary")}${
                  install.progress.receivedBytes > 0
                    ? ` · ${formatBytes(install.progress.receivedBytes)}`
                    : ""
                }`
              : "Starting…"}
        </span>
        <Button variant="ghost" size="sm" disabled={state.cancelling} onClick={install.cancel}>
          Cancel
        </Button>
      </>
    );
  if (state.step === "installed")
    return (
      <>
        <Link
          to="/settings/providers/$provider"
          params={{ provider: `acp:${props.name}` }}
          onClick={props.onClose}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open in Providers
        </Link>
        <Button variant="primary" size="sm" onClick={props.onClose}>
          Done
        </Button>
      </>
    );
  if (state.step === "confirm" && plan)
    return (
      <>
        <span className="min-w-0 flex-1 truncate text-sm">
          Install {props.name} {plan.version} with the plan above?
        </span>
        <Button variant="ghost" size="sm" onClick={install.back}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" autoFocus onClick={() => install.start(plan)}>
          Confirm install
        </Button>
      </>
    );
  if (!plan)
    return (
      <Button variant="ghost" size="sm" onClick={props.onClose}>
        Close
      </Button>
    );
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        Nothing installs until you confirm.
      </span>
      <Button
        variant="primary"
        size="sm"
        onClick={state.step === "failed" ? props.onRetry : install.confirm}
      >
        {state.step === "failed" ? "Try again" : label}
      </Button>
    </>
  );
}
