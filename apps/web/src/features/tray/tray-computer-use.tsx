import { useSidebarThread } from "@ace/client-react";
import type { ScreenState } from "@ace/protocol";
import { screenSession } from "@ace/ui-core/computer-use";
import { AppMark } from "@/components/app-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { menuItem, menuSeparator } from "@/components/ui/menu-styles.ts";
import { useAgentLabel } from "@/components/agent-picker.tsx";
import type { DesktopTray } from "@/boot/desktop-tray.ts";
import { cn } from "@/lib/cn.ts";
import { useComputerUse, type ComputerUse } from "@/features/computer-use/index.ts";
import { TrayCommand, TrayEmpty, TrayList, TraySection } from "./tray-parts.tsx";

export interface AppsInUse {
  use: ComputerUse;
  /** Apps an agent or the person holds now, or that are starting. */
  live: readonly ScreenState[];
}

/** Computer use for the popover: the channel's controls and the sessions that are running. */
export function useAppsInUse(): AppsInUse {
  const use = useComputerUse();
  const live = use.snapshot.states.filter(
    (state) => state.lifecycle === "live" || state.lifecycle === "starting",
  );
  return { use, live };
}

/**
 * The Computer use tab, as a macOS menu-bar module: the switch that lets agents use apps first,
 * then each app in use with the thread that holds it (Take over and Stop under the pointer),
 * then the settings page.
 */
export function TrayComputerUse(props: { apps: AppsInUse; tray: DesktopTray }) {
  const { use, live } = props.apps;
  const settings = (
    <TrayCommand
      label="Computer use settings…"
      onClick={() => props.tray.open({ kind: "settings", page: "computer-use" })}
    />
  );
  if (use.snapshot.unavailable)
    return (
      <>
        <TrayEmpty>Computer use isn't available on this computer.</TrayEmpty>
        <div className={menuSeparator} />
        {settings}
      </>
    );
  const enabled = use.snapshot.enabled === true;
  return (
    <>
      <label className={cn(menuItem, "h-9 hover:bg-accent")}>
        <span className="flex-1">Let agents use apps</span>
        <Switch
          checked={enabled}
          disabled={use.snapshot.enabled === undefined || use.pending}
          onCheckedChange={(next) => void use.enable(next)}
        />
      </label>
      {enabled &&
        (live.length === 0 ? (
          <TrayEmpty>No agent is using an app.</TrayEmpty>
        ) : (
          <TrayList>
            <li>
              <TraySection label="In use">
                {live.map((state) => (
                  <AppRow key={state.sessionId} state={state} use={use} />
                ))}
              </TraySection>
            </li>
          </TrayList>
        ))}
      <div className={menuSeparator} />
      {settings}
    </>
  );
}

function AppRow(props: { state: ScreenState; use: ComputerUse }) {
  const { state, use } = props;
  const holderName = useAgentLabel(state.holder?.threadId, state.holder?.agentId);
  const thread = useSidebarThread(state.holder?.threadId ?? "")?.title;
  const view = screenSession(state, () => holderName);
  const problem = use.problem(state.sessionId);
  const who = state.controller === "human" ? "You" : thread;
  return (
    <div className="group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 focus-within:bg-accent hover:bg-accent">
      <AppMark name={view.app} bundleId={view.bundleId} fallback="row" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-ui text-foreground">{view.app}</span>
        <span
          role={problem ? "alert" : undefined}
          className="mt-0.5 block truncate text-meta text-muted-foreground"
        >
          {problem?.title ?? who ?? view.status}
        </span>
      </span>
      <span className="shrink-0 text-meta text-subtle-foreground group-focus-within:hidden group-hover:hidden">
        {view.foreground ? "In front" : "Background"}
      </span>
      <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
        {!view.viewOnly && state.controller !== "human" && (
          <Button
            size="xs"
            variant="ghost"
            className="text-foreground"
            disabled={use.pending}
            onClick={() => void use.takeover(state.sessionId)}
          >
            Take over
          </Button>
        )}
        {view.stoppable && (
          <Button
            size="xs"
            variant="ghost"
            disabled={use.pending}
            onClick={() => void use.stop(state.sessionId)}
          >
            Stop
          </Button>
        )}
      </span>
    </div>
  );
}
