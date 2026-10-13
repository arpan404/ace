import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { StartupLayout, StartupStatus } from "./startup-layout.tsx";
import type { DesktopDaemon } from "@/boot/desktop.ts";
import { startupFailure } from "@/features/connect/index.ts";
import { removeBootSplash } from "@/lib/boot-splash.ts";
import { useStartup, useStartupState } from "@/lib/startup/startup.tsx";
import { startupView, type StartupAction } from "@/lib/startup/startup-state.ts";

const noSubscribe = () => () => {};

const labels: Record<StartupAction, string> = {
  retry: "Try again",
  restart: "Restart ace",
  logs: "View logs",
  connect: "Connect manually…",
  reload: "Reload",
  quit: "Quit ace",
};

/**
 * The window from first paint until the app has its first real data: the ace mark, centred on
 * the theme's background, exactly where `index.html` drew it (which this replaces unseen). A
 * start that takes longer than a moment says "Starting ace…"; one that stalls offers a way out;
 * a daemon that failed says so with Try again and View logs. Then it cross-fades to the app.
 */
export function StartupScreen(props: { daemon?: DesktopDaemon | undefined; reload?: () => void }) {
  const { daemon } = props;
  const startup = useStartup();
  const state = useStartupState();
  useEffect(() => removeBootSplash(document), []);
  useEffect(() => {
    if (!startup || !daemon) return;
    const report = (status: { state: string; message?: string | undefined }) =>
      startup.dispatch({ type: "daemon", state: status.state, message: status.message });
    // The current state, unless a newer one has already arrived as an event.
    let heard = false;
    const stop = daemon.onStatus((status) => {
      heard = true;
      report(status);
    });
    void daemon.status().then(
      (status) => {
        if (status && !heard) report(status);
      },
      () => {},
    );
    return stop;
  }, [startup, daemon]);
  const manual = useSyncExternalStore(startup?.subscribe ?? noSubscribe, () =>
    startup?.connectManually(),
  );
  const view = useMemo(
    () =>
      startupView(
        state,
        { desktop: daemon !== undefined, logs: daemon?.showLogs !== undefined, connect: !!manual },
        startupFailure,
      ),
    [state, daemon, manual],
  );
  if (!view.shown || !startup) return null;

  const act = (action: StartupAction) => {
    if (action === "retry") {
      startup.dispatch({ type: "retry" });
      void daemon?.restart().catch(() => {});
    } else if (action === "restart") void daemon?.restart().catch(() => {});
    else if (action === "logs") void daemon?.showLogs?.().catch(() => {});
    else if (action === "quit") void daemon?.quit?.().catch(() => {});
    else if (action === "connect") manual?.();
    else (props.reload ?? (() => location.reload()))();
  };
  return (
    <StartupLayout
      leaving={view.leaving}
      busy={view.failure === undefined}
      onLeft={() => startup.dispatch({ type: "left" })}
    >
      {view.failure !== undefined ? (
        <div role="alert" className="fx-view-in flex max-w-[360px] flex-col gap-1.5">
          <p className="text-ui font-semibold text-foreground">ace couldn't start</p>
          <p className="text-sm leading-normal text-muted-foreground">{view.failure}</p>
        </div>
      ) : (
        <StartupStatus message={view.message} />
      )}
      {view.actions.length > 0 && (
        <div className="fx-view-in flex flex-wrap justify-center gap-2">
          {view.actions.map((action, index) => (
            <Button
              key={action}
              size="sm"
              variant={index === 0 && view.failure !== undefined ? "primary" : "secondary"}
              onClick={() => act(action)}
            >
              {labels[action]}
            </Button>
          ))}
        </div>
      )}
    </StartupLayout>
  );
}
