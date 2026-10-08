import { PastSessions } from "@/features/history/index.ts";
import { ToolchainHints } from "@/features/diagnostics/index.ts";
import { useClient } from "@ace/client-react";
import { providerNames, readinessView } from "@ace/ui-core";
import { ArrowClockwiseIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { dismissOnboarding, refreshProviders, useOnboarding } from "@/lib/provider-readiness.ts";
import { useCatalogSignals } from "@/lib/provider-signals.ts";
import { Screen } from "@/features/shell/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { MissingRow, ProviderRow } from "./provider-card.tsx";

const names = new Intl.ListFormat("en", { type: "conjunction" });

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
  const signals = useCatalogSignals();
  const [checking, setChecking] = useState(false);
  const [welcomed, setWelcomed] = useState(false);
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
    .map((row) => ({ row, view: readinessView(row, signals(row.provider)) }));
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
  if (!welcomed)
    return (
      <Screen title="Set up">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-4 px-5 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-title">Welcome to ace</h2>
          <p className="max-w-[44ch] text-base text-muted-foreground">
            Work with your coding agents in one place. Connect the agents on this computer, then
            choose a project.
          </p>
          <div>
            <Button variant="primary" onClick={() => setWelcomed(true)}>
              Get started
              <ArrowRightIcon aria-hidden size={14} />
            </Button>
          </div>
        </div>
      </Screen>
    );
  return (
    <Screen title="Set up">
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          <div className="fx-view-in mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-2xl font-semibold tracking-title text-foreground">
                {ready ? "You're ready to go" : "Welcome to ace"}
              </h2>
              <p className="max-w-[62ch] text-base leading-normal text-muted-foreground">
                {ready
                  ? `${names.format(readyNames)} ${ready === 1 ? "is" : "are"} ready. Add a project to start, or connect more agents first.`
                  : "ace works with the coding agents on this computer, using your own accounts. Sign in to one to start."}
              </p>
            </div>
            {onboarding.isError ? (
              <p role="alert" className="text-muted-foreground">
                This computer can't list its agents yet. Check Settings → Providers.
              </p>
            ) : !data ? (
              <ListSkeleton label="providers" shape="row" rows={4} />
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Progress ready={ready} total={installed.length} />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={checking}
                    onClick={() => void checkAgain()}
                  >
                    <ArrowClockwiseIcon aria-hidden size={13} />
                    {checking ? "Checking…" : "Check again"}
                  </Button>
                </div>
                {installed.length > 0 && (
                  <ul aria-label="Providers on this computer" className="flex flex-col">
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
                      {installed.length ? "More agents you can use" : "Install one to begin"}
                    </h3>
                    <ul className="flex flex-col">
                      {missing.map(({ row, view }) => (
                        <MissingRow key={row.provider} row={row} view={view} />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
            <PastSessions />
            <ToolchainHints />
          </div>
        </div>
        <div className="shrink-0 border-t px-5 py-3 sm:px-8">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
            <Button variant="ghost" onClick={() => leave("/")}>
              Skip for now
            </Button>
            {ready ? (
              <Button
                variant="primary"
                className="ml-auto"
                onClick={() => {
                  leave("/");
                  projects.open({ kind: "add", tab: "open" });
                }}
                onPointerEnter={projects.preload}
              >
                Add a project
                <ArrowRightIcon aria-hidden size={14} />
              </Button>
            ) : (
              <span className="ml-auto text-sm text-muted-foreground">
                Sign in to one agent to continue
              </span>
            )}
          </div>
        </div>
      </div>
    </Screen>
  );
}

/** "2 of 3 ready", with a bar that fills as sign-ins finish. */
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
