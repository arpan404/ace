import { PastSessions } from "@/features/history/index.ts";
import { ToolchainHints } from "@/features/diagnostics/index.ts";
import { useClient } from "@ace/client-react";
import { providerNames } from "@ace/ui-core";
import { CheckIcon, ArrowClockwiseIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { dismissOnboarding, refreshProviders, useOnboarding } from "@/lib/provider-readiness.ts";
import { useProviderAccountModels } from "@/features/accounts/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { ProviderRow } from "./provider-card.tsx";

/**
 * First-run setup (`/setup`): the providers found on the daemon's
 * computer, each ready or with the one step that readies it, the suggested next step
 * highlighted, and progress that moves as sign-ins finish anywhere. Done or skipped, it stays
 * dismissed for this device.
 */
export function SetupScreen() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const onboarding = useOnboarding();
  const projects = useProjectDialogs();
  const { model } = useProviderAccountModels();
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState(0);
  const leave = (to: "/") => {
    void dismissOnboarding(client, queryClient, true);
    void navigate({ to });
  };
  const checkAgain = async () => {
    setChecking(true);
    try {
      await client.request({ type: "providers.request", operation: "refresh" });
    } catch {
      // Offline: the reconnect reads providers again anyway.
    }
    refreshProviders(queryClient);
    setChecking(false);
  };
  const data = onboarding.data;
  // Each provider as Settings says it, with the catalog deciding whether a CLI that doesn't
  // report its sign-in works: ready when it lists models.
  const cards = (data?.providers ?? [])
    .filter((row) => row.provider !== "acp")
    .flatMap((row) => {
      const view = model(row.provider).view;
      return view ? [{ row, view }] : [];
    });
  const installed = cards.filter((card) => card.view.state !== "not_installed");
  const missing = cards.filter((card) => card.view.state === "not_installed");
  const readyNames = installed
    .filter((card) => card.view.ready)
    .map((card) => providerNames[card.row.provider]);
  const ready = readyNames.length;
  // Only a card that needs action is highlighted: the daemon's suggestion when it does, else
  // the first that does; none once something is ready (Start a thread is the next step then).
  const actionable = installed.filter((card) => card.view.primary);
  const next = ready
    ? undefined
    : (actionable.find((card) => card.row.provider === data?.next.provider) ?? actionable[0])?.row
        .provider;
  const headings = [
    "Welcome to ace",
    "Connect your agents",
    "Check your tools",
    "Choose your first project",
  ];
  return (
    <Screen
      title="Set up"
      actions={
        <Button variant="ghost" onClick={() => leave("/")}>
          Skip for now
        </Button>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10">
          <div
            key={step}
            className="fx-view-in mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center gap-7"
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <h2 className="text-2xl font-semibold tracking-title">{headings[step]}</h2>
              <p className="max-w-[44ch] text-base leading-normal text-muted-foreground">
                {step === 0
                  ? "Your coding agents, projects, and conversations. Together in one place."
                  : step === 1
                    ? "Use the agents and accounts already on this computer. Connect one to begin."
                    : step === 2
                      ? "ace uses this computer’s tools. Optional device tools can be set up later."
                      : "Pick a folder your agents can work in. ace will detect its project icon and Git setup."}
              </p>
            </div>
            {step === 0 && (
              <div className="flex w-full max-w-sm flex-col gap-5">
                <Feature title="Keep your own accounts">
                  Connect Codex, Claude Code, and other installed agents.
                </Feature>
                <Feature title="Work in your projects">
                  Use a local checkout or an isolated worktree.
                </Feature>
                <Feature title="Stay in control">
                  Review actions and pick up conversations across your devices.
                </Feature>
              </div>
            )}
            {step === 1 && (
              <div className="flex w-full flex-col gap-4">
                {onboarding.isError ? (
                  <p role="alert" className="text-ui text-muted-foreground">
                    This computer can't list its agents yet. Check Settings → Providers.
                  </p>
                ) : !data ? (
                  <ListSkeleton label="providers" shape="row" rows={4} />
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <Progress ready={ready} total={installed.length} />
                      <IconButton
                        size="sm"
                        icon={ArrowClockwiseIcon}
                        label={checking ? "Checking…" : "Check again"}
                        disabled={checking}
                        onClick={() => void checkAgain()}
                      />
                    </div>
                    {installed.length > 0 && (
                      <ul aria-label="Providers on this computer" className="divide-y px-4">
                        {installed.map(({ row, view }) => (
                          <ProviderRow
                            key={row.provider}
                            row={row}
                            view={view}
                            next={next === row.provider}
                          />
                        ))}
                      </ul>
                    )}
                    {missing.length > 0 && (
                      <section aria-label="Not installed" className="flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-muted-foreground">
                          {installed.length ? "More agents" : "Install an agent"}
                        </h3>
                        <ul className="divide-y px-4">
                          {missing.map(({ row, view }) => (
                            <ProviderRow key={row.provider} row={row} view={view} />
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                )}
              </div>
            )}
            {step === 2 && (
              <div className="w-full p-5">
                <ToolchainHints />
              </div>
            )}
            {step === 3 && (
              <div className="flex w-full flex-col gap-4">
                <details className="px-5 py-3">
                  <summary className="cursor-pointer list-none text-ui text-muted-foreground">
                    Bring an existing conversation ›
                  </summary>
                  <div className="mt-4">
                    <PastSessions />
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 border-t px-6 py-5 sm:px-10">
          <div className="mx-auto grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-4">
            <div>
              <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
                Back
              </Button>
            </div>
            <ol aria-label={`Step ${step + 1} of 4`} className="flex items-center gap-2">
              {headings.map((heading, index) => (
                <li
                  key={heading}
                  aria-current={index === step ? "step" : undefined}
                  className={
                    index === step
                      ? "h-1.5 w-5 rounded-full bg-foreground"
                      : "size-1.5 rounded-full bg-muted-foreground/30"
                  }
                >
                  <span className="sr-only">{heading}</span>
                </li>
              ))}
            </ol>
            <div className="flex justify-end">
              <Button
                variant="primary"
                disabled={step === 1 && !ready}
                onClick={() => {
                  if (step < 3) setStep(step + 1);
                  else {
                    leave("/");
                    projects.open({ kind: "add", tab: "sources" });
                  }
                }}
                onPointerEnter={step === 3 ? projects.preload : undefined}
              >
                {step === 0 ? "Get started" : step === 3 ? "Add a project" : "Continue"}
                <ArrowRightIcon aria-hidden size={14} />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Screen>
  );
}

function Feature(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <CheckIcon aria-hidden size={18} className="mt-0.5 shrink-0 text-subtle-foreground" />
      <div>
        <p className="text-ui font-medium">{props.title}</p>
        <p className="mt-1 text-ui leading-normal text-muted-foreground">{props.children}</p>
      </div>
    </div>
  );
}

/** Provider progress updates independently of the current onboarding page. */
function Progress(props: { ready: number; total: number }) {
  const total = Math.max(props.total, 1);
  const text = `${props.ready} of ${props.total} ready`;
  return (
    <div className="flex flex-1 items-center gap-3">
      <ProgressBar
        label="Providers ready"
        value={Math.round((props.ready / total) * 100)}
        valueText={text}
        className="flex-1"
      />
      <span className="text-sm text-muted-foreground tabular-nums">{text}</span>
    </div>
  );
}
