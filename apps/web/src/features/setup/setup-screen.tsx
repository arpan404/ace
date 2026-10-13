import { PastSessions } from "@/features/history/index.ts";
import { useClient } from "@ace/client-react";
import {
  FolderOpenIcon,
  TerminalIcon,
  ArrowClockwiseIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { dismissOnboarding, refreshProviders, useOnboarding } from "@/lib/provider-readiness.ts";
import { useProviderAccountModels } from "@/features/accounts/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { ProviderRow } from "./provider-card.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";

const steps = [
  {
    heading: "Connect your agents",
    lede: "Use the agents and accounts already on this computer. Connect one to begin.",
    icon: TerminalIcon,
  },
  {
    heading: "Choose your first project",
    lede: "Pick a folder your agents can work in.",
    icon: FolderOpenIcon,
  },
] as const;

/**
 * First-run setup (`/setup`), two steps: the providers found on the daemon's computer, each
 * ready or with the one step that readies it (progress moves as sign-ins finish anywhere), then
 * the first project, whose folder browser opens straight from here. The tools a computer has
 * live in Settings → Computer use. Done or skipped, it stays dismissed for this device.
 */
export function SetupScreen() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const onboarding = useOnboarding();
  const projects = useProjectDialogs();
  const { model } = useProviderAccountModels();
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState<0 | 1>(0);
  const leave = () => {
    void dismissOnboarding(client, queryClient, true);
    void navigate({ to: "/" });
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
  const ready = installed.filter((card) => card.view.ready).length;
  // Only a card that needs action is highlighted: the daemon's suggestion when it does, else
  // the first that does; none once something is ready (Continue is the next step then).
  const actionable = installed.filter((card) => card.view.primary);
  const next = ready
    ? undefined
    : (actionable.find((card) => card.row.provider === data?.next.provider) ?? actionable[0])?.row
        .provider;
  const current = steps[step];
  return (
    <Screen title="Set up">
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10">
          <div
            key={step}
            className="fx-view-in mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center gap-7"
          >
            <div className="grid size-12 shrink-0 place-items-center">
              <current.icon aria-hidden size={36} />
            </div>
            <div className="flex flex-col items-center gap-3 text-center">
              <h2 className="text-2xl font-semibold tracking-title">{current.heading}</h2>
              <p className="max-w-[44ch] text-base leading-normal text-muted-foreground">
                {current.lede}
              </p>
            </div>
            {step === 0 && (
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
                      <ul aria-label="Providers on this computer" className="divide-y">
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
                        <ul className="divide-y">
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
            {step === 1 && (
              <Disclosure
                className="w-full py-3"
                summaryClassName="text-ui"
                summary="Bring an existing conversation"
              >
                <div className="mt-4">
                  <PastSessions />
                </div>
              </Disclosure>
            )}
          </div>
        </div>
        {/* Skip stays in one place on every step; Back sits beside the step's own action. */}
        <div className="shrink-0 px-6 py-5 sm:px-10">
          <div className="mx-auto grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-4">
            <div>
              <Button variant="secondary" onClick={leave}>
                Skip for now
              </Button>
            </div>
            <ol
              aria-label={`Step ${step + 1} of ${steps.length}`}
              className="flex items-center gap-2"
            >
              {steps.map((each, index) => (
                <li
                  key={each.heading}
                  aria-current={index === step ? "step" : undefined}
                  className={
                    index === step
                      ? "h-1.5 w-5 rounded-full bg-foreground"
                      : "size-1.5 rounded-full bg-muted-foreground/30"
                  }
                >
                  <span className="sr-only">{each.heading}</span>
                </li>
              ))}
            </ol>
            <div className="flex justify-end gap-2">
              {step === 1 && (
                <Button variant="ghost" onClick={() => setStep(0)}>
                  Back
                </Button>
              )}
              <Button
                variant="primary"
                disabled={step === 0 && !ready}
                onClick={() => {
                  if (step === 0) return setStep(1);
                  leave();
                  // Straight to the folder browser: a first project is most often a folder here.
                  projects.open({ kind: "add", tab: "open" });
                }}
                onPointerEnter={step === 1 ? projects.preload : undefined}
              >
                {step === 0 ? "Continue" : "Add a project"}
                <ArrowRightIcon aria-hidden size={14} />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Screen>
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
