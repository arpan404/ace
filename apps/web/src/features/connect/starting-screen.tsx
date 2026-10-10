import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { AceMark } from "@/components/ace-mark.tsx";
import { desktopAppVersion } from "@/boot/desktop.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { DesktopDaemon, DesktopDaemonStatus } from "@/boot/desktop.ts";
import { holdBootSplash } from "@/lib/boot-splash.ts";

/** When the wait gets an explanation, then a way out. */
export const startingNoteMs = 10_000;
export const startingHelpMs = 60_000;

type Schedule = (delayMs: number, run: () => void) => () => void;
const timers: Schedule = (delayMs, run) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

const statusWords: Record<string, string> = {
  starting: "Preparing your workspace…",
  restarting: "Restarting ace…",
  running: "Connecting to your workspace…",
  unreachable: "Waiting for ace to answer…",
};

/**
 * The desktop app's first paint while its daemon starts. It sits over the shell-shaped boot
 * splash (which stays until the shell paints, so nothing flashes) in the main pane's place. A
 * first start waits for the local daemon and its authenticated connection, not optional provider
 * history. After 10s it explains the service wait; after a minute it offers the logs, a
 * restart, connecting by hand and Quit.
 */
export function StartingScreen(props: {
  daemon?: DesktopDaemon | undefined;
  onConnectManually?: (() => void) | undefined;
  schedule?: Schedule;
  version?: string | undefined;
}) {
  const { daemon } = props;
  const schedule = props.schedule ?? timers;
  const version = props.version ?? desktopAppVersion();
  const [stage, setStage] = useState<"calm" | "note" | "help">("calm");
  const [status, setStatus] = useState<DesktopDaemonStatus | undefined>(undefined);
  useEffect(() => holdBootSplash(document), []);
  useEffect(() => {
    const stops = [
      schedule(startingNoteMs, () => setStage((now) => (now === "calm" ? "note" : now))),
      schedule(startingHelpMs, () => setStage("help")),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [schedule]);
  useEffect(
    () =>
      daemon?.onStatus((next) => {
        setStatus(next);
        if (next.state === "failed" || next.state === "unreachable") setStage("help");
      }),
    [daemon],
  );
  const live = status && statusWords[status.state];
  return (
    <div className="fixed inset-0 z-[141] grid place-items-center p-6 md:pl-[344px]">
      {/* The window has no title bar; the splash's header row moves it. */}
      <div aria-hidden className="fixed inset-x-0 top-0 h-[50px] [-webkit-app-region:drag]" />
      <div className="flex max-w-[360px] flex-col items-center gap-3 text-center">
        <div className="grid size-14 place-items-center rounded-xl bg-secondary text-ring">
          <AceMark className="size-10" />
        </div>
        <div className="space-y-1">
          <p className="text-xl font-semibold tracking-title text-foreground">ace</p>
          {version && <p className="text-xs text-subtle-foreground">v{version}</p>}
        </div>
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner />
          {stage === "help" ? "Startup needs attention" : (live ?? "Loading your workspace…")}
        </p>
        {stage !== "calm" && (
          <p className="fx-view-in text-sm leading-normal text-muted-foreground">
            Preparing local services and checking the connection.
            {live && <span className="mt-1 block text-subtle-foreground">{live}</span>}
          </p>
        )}
        {stage === "help" && (
          <div className="fx-view-in mt-2 flex flex-wrap justify-center gap-2">
            {daemon?.showLogs && (
              <Button size="sm" onClick={() => void daemon.showLogs?.()}>
                Show logs
              </Button>
            )}
            {daemon && (
              <Button
                size="sm"
                onClick={() => {
                  setStatus({ state: "restarting" });
                  void daemon.restart().then(setStatus, () => setStatus({ state: "failed" }));
                }}
              >
                Restart ace
              </Button>
            )}
            {props.onConnectManually && (
              <Button size="sm" onClick={props.onConnectManually}>
                Connect manually…
              </Button>
            )}
            {daemon?.quit && (
              <Button size="sm" variant="ghost" onClick={() => void daemon.quit?.()}>
                Quit ace
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
