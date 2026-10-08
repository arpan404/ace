import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { DesktopDaemon, DesktopDaemonStatus, DiagnosticCheck } from "@/boot/desktop.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { startupCheck, startupFailure } from "./startup-copy.ts";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { ConnectCard } from "./connect-card.tsx";

const busyStates = new Set(["starting", "restarting"]);

/**
 * The desktop app's own daemon failed to start. The desktop manages that daemon, so this
 * never asks the person to run a command: it says why, and offers a restart, diagnostics,
 * the logs and Quit. The desktop reloads the window once its daemon runs again.
 */
export function DesktopFailureScreen(props: { reason: string; daemon: DesktopDaemon }) {
  useDismissBootSplash();
  const { daemon } = props;
  const [status, setStatus] = useState<DesktopDaemonStatus | undefined>(undefined);
  const [checks, setChecks] = useState<DiagnosticCheck[] | "running" | { error: string }>();
  useEffect(() => daemon.onStatus(setStatus), [daemon]);
  const busy = status !== undefined && busyStates.has(status.state);
  const restart = async () => {
    setStatus({ state: "restarting" });
    try {
      setStatus((await daemon.restart()) ?? { state: "failed" });
    } catch (error) {
      setStatus({ state: "failed", message: error instanceof Error ? error.message : undefined });
    }
  };
  const diagnose = async () => {
    setChecks("running");
    try {
      setChecks(await daemon.diagnose());
    } catch (error) {
      setChecks({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  const reason = status?.state === "failed" && status.message ? status.message : props.reason;
  return (
    <ConnectCard labelledBy="desktop-failure-title" wide={Array.isArray(checks)}>
      <h1 id="desktop-failure-title" className="mt-4 text-xl font-semibold tracking-title">
        ace didn't start
      </h1>
      <p className="mt-1.5 text-ui leading-normal text-muted-foreground">
        ace stopped before this window could connect.
      </p>
      <p className="mt-4 text-sm text-foreground">{startupFailure(reason)}</p>
      <div role="status" aria-live="polite" className="text-sm">
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-muted-foreground">
            <Spinner />
            {status.state === "restarting" ? "Restarting ace…" : "Starting ace…"}
          </p>
        )}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="primary"
          className="h-9 flex-1"
          disabled={busy}
          focusableWhenDisabled
          onClick={() => void restart()}
        >
          Restart ace
        </Button>
        <Button
          className="h-9 flex-1"
          disabled={checks === "running"}
          focusableWhenDisabled
          onClick={() => void diagnose()}
        >
          {checks === "running" && <Spinner className="text-current" />}
          Run diagnostics
        </Button>
      </div>
      <div className="mt-2 flex gap-2">
        {daemon.showLogs && (
          <Button variant="ghost" className="flex-1" onClick={() => void daemon.showLogs?.()}>
            Show logs
          </Button>
        )}
        {daemon.quit && (
          <Button variant="ghost" className="flex-1" onClick={() => void daemon.quit?.()}>
            Quit ace
          </Button>
        )}
      </div>
      {checks !== undefined && checks !== "running" && <Diagnostics checks={checks} />}
    </ConnectCard>
  );
}

function Diagnostics(props: { checks: DiagnosticCheck[] | { error: string } }) {
  if (!Array.isArray(props.checks))
    return (
      <p role="alert" className="mt-4 text-sm text-destructive">
        Diagnostics couldn't run. Try again, or open the logs for details.
      </p>
    );
  return (
    <section aria-label="Diagnostics" className="mt-4">
      <ul className="flex max-h-64 flex-col divide-y overflow-auto text-sm">
        {props.checks.map((check) => {
          const ok = check.status === "ok" || check.status === "pass";
          const copy = startupCheck(check);
          return (
            <li key={check.id} className="py-2">
              <div className="flex h-5 items-center justify-between gap-3">
                <span>{copy.label}</span>
                <StatusLabel
                  tone={ok ? "done" : "needs-you"}
                  label={ok ? "Passed" : "Needs attention"}
                />
              </div>
              {!ok && <p className="text-sm text-muted-foreground">{copy.fix}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
