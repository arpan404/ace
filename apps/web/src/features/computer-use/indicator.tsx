import type { ScreenState } from "@ace/protocol";
import { addressHost } from "@ace/ui-core";
import { indicatorSessions, screenSession, targetBundle } from "@ace/ui-core/computer-use";
import { CursorClickIcon, GlobeSimpleIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useAgentLabel } from "@/components/agent-picker.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useBrowserControls, type BrowserControl } from "@/lib/browser-control.ts";
import { AppMark } from "@/components/app-mark.tsx";
import { StopAllButton } from "./sections.tsx";
import { useComputerUse, type ComputerUse } from "./use-computer-use.ts";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The sidebar indicator shows every active app session and any agent-held or private browser.
 * Its popover lists each with Take over and Stop, and opens the live sessions.
 */
export default function ComputerUseIndicator() {
  const use = useComputerUse();
  const sessions = indicatorSessions(use.snapshot.states);
  const browsers = [...useBrowserControls().values()].filter(
    (control) => control.controller === "agent" || control.private,
  );
  if (sessions.length === 0 && browsers.length === 0) return null;
  const parts = [
    ...(sessions.length ? [plural(sessions.length, "app", "apps")] : []),
    ...(browsers.length ? [plural(browsers.length, "browser", "browsers")] : []),
  ];
  // Capture still running after an agent let go (stopping, failed) is named as capture.
  const label = sessions.every((state) => state.controller === "agent")
    ? `Agents are using ${parts.join(" and ")}`
    : `Computer use is active in ${parts.join(" and ")}`;
  const capturing = sessions.some((state) => state.indicator);
  return (
    <Popover>
      <Tip label={label} side="top">
        <PopoverTrigger
          aria-label={label}
          className="relative grid size-8 place-items-center rounded-lg text-link transition-colors duration-(--dur-1) focus-ring hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent pointer-coarse:size-11"
        >
          <Icon icon={CursorClickIcon} size={18} active />
          {capturing && (
            <span
              aria-hidden
              data-tone="needs-you"
              className="absolute top-1 right-1 size-[7px] rounded-full bg-(--tone) shadow-[0_0_0_2px_var(--sidebar)]"
            />
          )}
        </PopoverTrigger>
      </Tip>
      <PopoverContent side="top" align="start" className="flex w-96 flex-col gap-2">
        <PopoverTitle className="text-ui font-medium">{label}</PopoverTitle>
        <ul className="flex flex-col">
          {sessions.map((state, index) => (
            <SessionRow
              key={state.sessionId}
              state={state}
              use={use}
              fallback={
                sessions.findIndex((other) => targetBundle(other) === targetBundle(state)) === index
                  ? "group"
                  : "row"
              }
            />
          ))}
          {browsers.map((control) => (
            <BrowserRow key={control.threadId} control={control} />
          ))}
        </ul>
        <div className="flex items-center gap-2 border-t pt-2">
          <Link
            to="/settings/computer-use"
            className="min-w-0 flex-1 rounded-xs text-sm text-link focus-ring hover:underline"
          >
            Open live sessions
          </Link>
          {sessions.length > 0 && <StopAllButton use={use} />}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SessionRow(props: { state: ScreenState; use: ComputerUse; fallback: "group" | "row" }) {
  const { state, use } = props;
  const name = useAgentLabel(state.holder?.threadId, state.holder?.agentId);
  const view = screenSession(state, () => name);
  return (
    <li className="flex items-center gap-2 border-b py-2 last:border-b-0">
      <AppMark name={view.app} bundleId={view.bundleId} fallback={props.fallback} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui">{view.app}</p>
        <p className="truncate text-xs text-subtle-foreground">
          {state.controller === "agent" ? name : view.status}
          {view.foreground ? " · foreground" : ""}
          {view.capturing && " · capturing"}
        </p>
      </div>
      {state.controller === "agent" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={use.pending}
          onClick={() => void use.takeover(state.sessionId)}
        >
          Take over
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Stop ${view.app}`}
        disabled={use.pending || state.lifecycle === "stopping"}
        onClick={() => void use.stop(state.sessionId)}
      >
        {state.lifecycle === "failed" ? "Stop again" : "Stop"}
      </Button>
    </li>
  );
}

function BrowserRow(props: { control: BrowserControl }) {
  const { control } = props;
  return (
    <li className="flex items-center gap-2 border-b py-2 last:border-b-0">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/8 text-muted-foreground">
        <Icon icon={control.private ? LockSimpleIcon : GlobeSimpleIcon} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui">{addressHost(control.url) ?? "Browser"}</p>
        <p className="truncate text-xs text-subtle-foreground">
          {control.private ? "Private: agents can't see this page" : "An agent is using this page"}
        </p>
      </div>
      <Link
        to="/t/$threadId"
        params={{ threadId: control.threadId }}
        className="rounded-xs px-2 text-sm text-link focus-ring hover:underline"
      >
        Show
      </Link>
    </li>
  );
}
