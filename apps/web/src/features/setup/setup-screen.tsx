import { useClient } from "@ace/client-react";
import { providerNames } from "@ace/ui-core";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { dismissOnboarding, refreshProviders, useOnboarding } from "@/lib/provider-readiness.ts";
import { Screen } from "@/features/shell/index.ts";
import { ProviderCard } from "./provider-card.tsx";

/**
 * First-run setup (and Settings → Set up providers): the providers found on the daemon's
 * computer, each ready or with the one step that readies it, the suggested next step
 * highlighted, and progress that moves as sign-ins finish anywhere. Done or skipped, it stays
 * dismissed for this device.
 */
export function SetupScreen() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const onboarding = useOnboarding();
  const [checking, setChecking] = useState(false);
  const leave = (to: "/" | "/new") => {
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
  const providers = data?.providers.filter((row) => row.provider !== "acp") ?? [];
  const installed = providers.filter((row) => row.readiness !== "not_installed");
  const missing = providers.filter((row) => row.readiness === "not_installed");
  const ready = data?.ready.length ?? 0;
  const next = data?.next;
  return (
    <Screen title="Set up providers">
      <div className="h-full overflow-y-auto px-5 pt-8 pb-16 sm:px-8">
        <div className="mx-auto flex w-full max-w-(--column) flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-title text-foreground">
              {ready ? "You're ready" : "Connect a coding agent"}
            </h2>
            <p className="text-muted-foreground">
              ace drives the agent CLIs on this computer with your own accounts. Sign in to one to
              start; your credentials stay with each CLI.
            </p>
          </div>
          {onboarding.isError ? (
            <p role="alert" className="text-muted-foreground">
              This daemon can't list its providers yet. Check Settings → Providers.
            </p>
          ) : !data ? (
            <ListSkeleton label="providers" shape="row" rows={4} />
          ) : (
            <>
              <Progress ready={ready} total={installed.length} />
              {ready > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-card bg-ring/10 px-4 py-3">
                  <p className="min-w-0 flex-1">
                    {data.ready.map((provider) => providerNames[provider]).join(", ")}{" "}
                    {ready === 1 ? "is" : "are"} signed in. You can add more any time.
                  </p>
                  <Button variant="primary" onClick={() => leave("/new")}>
                    Start a thread
                  </Button>
                </div>
              )}
              {installed.length > 0 && (
                <ul aria-label="Providers on this computer" className="grid gap-2 sm:grid-cols-2">
                  {installed.map((row) => (
                    <ProviderCard
                      key={row.provider}
                      row={row}
                      next={!ready && next?.provider === row.provider}
                    />
                  ))}
                </ul>
              )}
              {missing.length > 0 && (
                <section aria-label="Not installed" className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {installed.length ? "Also available" : "Install one to begin"}
                  </h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {missing.map((row) => (
                      <ProviderCard
                        key={row.provider}
                        row={row}
                        next={!ready && next?.provider === row.provider}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => leave("/")}>
              Skip for now
            </Button>
            <Button
              variant="ghost"
              className="ml-auto"
              disabled={checking}
              onClick={() => void checkAgain()}
            >
              <ArrowClockwiseIcon aria-hidden size={14} />
              {checking ? "Checking…" : "Check again"}
            </Button>
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
    <div className="flex items-center gap-3">
      <div
        role="progressbar"
        aria-label="Providers ready"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={props.ready}
        aria-valuetext={text}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
      >
        <div
          className="h-full rounded-full bg-status-done transition-[width] duration-(--dur-3)"
          style={{ width: `${(props.ready / total) * 100}%` }}
        />
      </div>
      <span className="text-sm text-muted-foreground tabular-nums">{text}</span>
    </div>
  );
}
