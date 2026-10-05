import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { DesktopDaemon, DesktopDaemonStatus, DiagnosticCheck } from "@/boot/desktop.ts";
import { cn } from "@/lib/cn.ts";
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
        ace's daemon didn't start
      </h1>
      <p className="mt-1.5 text-ui leading-normal text-muted-foreground">
        ace runs a background daemon that drives your coding agents. It stopped before this window
        could reach it.
      </p>
      <p className="mt-4 rounded-md bg-secondary px-3 py-2.5 font-mono text-sm break-words whitespace-pre-wrap text-foreground">
        {reason}
      </p>
      <div role="status" aria-live="polite" className="text-sm">
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-muted-foreground">
            <Spinner />
            {status.state === "restarting" ? "Restarting the daemon…" : "Starting the daemon…"}
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
          Restart daemon
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
        Diagnostics couldn't run: {props.checks.error}
      </p>
    );
  return (
    <section aria-label="Diagnostics" className="mt-4 rounded-md bg-secondary px-3 py-2.5">
      <ul className="flex max-h-64 flex-col gap-1.5 overflow-auto font-mono text-sm">
        {props.checks.map((check) => {
          const ok = check.status === "ok" || check.status === "pass";
          return (
            <li key={check.id} className="flex flex-col">
              <span className={cn(ok ? "text-muted-foreground" : "text-foreground")}>
                <span aria-hidden className={ok ? "text-status-done" : "text-status-failed"}>
                  {ok ? "✓ " : "✕ "}
                </span>
                <span className="sr-only">{ok ? "Passed: " : "Problem: "}</span>
                {check.id}: {check.message}
              </span>
              {!ok && check.fix && <span className="pl-4 text-muted-foreground">{check.fix}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
