import { ApproveApp } from "./approve-app.tsx";
import type { ScreenGrant } from "@ace/protocol";
import {
  grantRows,
  targetBundle,
  permissionsReading,
  stopAllSummary,
  visibleSessions,
} from "@ace/ui-core/computer-use";
import { MonitorIcon, StopCircleIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { AppMark } from "@/components/app-mark.tsx";
import { SessionCard } from "./session-card.tsx";
import type { ComputerUse } from "./use-computer-use.ts";

/** Computer use on or off: off stops every session and keeps agents from starting one. */
export function EnableRow(props: { use: ComputerUse }) {
  const { use } = props;
  const id = useId();
  const { snapshot } = use;
  const description = snapshot.unavailable
    ? "ace on this machine has no screen helper, so agents can't use apps here."
    : !snapshot.connected
      ? "Connecting to the screen helper…"
      : "Approve apps before agents use them.";
  return (
    <SettingRow
      title="Let agents use apps"
      description={description}
      htmlFor={id}
      density="compact"
      inline
    >
      <Switch
        id={id}
        checked={snapshot.enabled === true}
        disabled={!snapshot.connected || snapshot.unavailable || use.pending}
        onCheckedChange={(checked) => void use.enable(checked)}
      />
    </SettingRow>
  );
}

/**
 * The kill switch: stops every session, releases every agent and turns computer use off. While
 * the daemon works it says Stopping and takes no second press; then it says what happened.
 */
export function StopAllButton(props: { use: ComputerUse; className?: string }) {
  const { use } = props;
  const stopping = use.stopping.state === "stopping";
  const summary = stopAllSummary(use.stopping);
  return (
    <div className={cn("flex flex-col items-end gap-1", props.className)}>
      <Button
        size="sm"
        variant="primary"
        aria-busy={stopping}
        disabled={
          stopping || !use.snapshot.connected || use.pending || use.snapshot.enabled === false
        }
        onClick={() => void use.stopAll()}
      >
        {stopping ? <Spinner /> : <StopCircleIcon aria-hidden size={14} />}
        {stopping ? "Stopping all computer use…" : "Stop all computer use"}
      </Button>
      {summary && (
        <p
          role={use.stopping.state === "failed" ? "alert" : "status"}
          className={cn(
            "max-w-72 text-right text-xs",
            use.stopping.state === "failed" ? "text-status-failed" : "text-muted-foreground",
          )}
        >
          {summary}
        </p>
      )}
    </div>
  );
}

/**
 * Every app an agent or a person controls, up to eight, each with its live picture. `threadId`
 * puts that thread's sessions first and lets Delegate offer its agents.
 */
export function LiveSessions(props: {
  use: ComputerUse;
  threadId?: string | undefined;
  /** One column, for a side panel. */
  narrow?: boolean;
  compact?: boolean;
}) {
  const { use, threadId } = props;
  const sessions = visibleSessions(use.snapshot.states).toSorted(
    (a, b) => Number(b.holder?.threadId === threadId) - Number(a.holder?.threadId === threadId),
  );
  if (!use.snapshot.connected && sessions.length === 0)
    return <EmptyState variant="inline" title="Connecting to the screen helper…" />;
  if (sessions.length === 0)
    return <p className="py-2 text-sm text-muted-foreground">No live sessions.</p>;
  return (
    <ul
      aria-label="Live sessions"
      className={
        props.compact
          ? "flex flex-col"
          : cn("grid grid-cols-1 gap-3", !props.narrow && "md:grid-cols-2")
      }
    >
      {sessions.map((state, index) => (
        <li key={state.sessionId} className="min-w-0">
          <SessionCard
            state={state}
            use={use}
            threadId={threadId}
            live={!props.compact}
            compact={props.compact}
            fallback={
              sessions.findIndex((other) => targetBundle(other) === targetBundle(state)) === index
                ? "group"
                : "row"
            }
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Apps agents may use, with the scope each grant has and Revoke. Sensitive apps say they still
 * ask every turn. `threadId` lists only grants that apply to that thread.
 */
export function ApprovedApps(props: { use: ComputerUse; threadId?: string | undefined }) {
  const { use, threadId } = props;
  const { session } = use;
  const [read, setRead] = useState<{ reload: string; grants: readonly ScreenGrant[] }>();
  const [version, setVersion] = useState(0);
  const connected = use.snapshot.connected;
  // Read again after a revoke, and when sessions come and go: answering an agent's request
  // (which adds a grant) is what starts one.
  const reload = `${version}:${use.snapshot.states.length}`;
  useEffect(() => {
    if (!session || !connected) return;
    let current = true;
    session.grants(threadId).then(
      (grants) => current && setRead({ reload, grants }),
      () => current && setRead({ reload, grants: [] }),
    );
    return () => {
      current = false;
    };
  }, [session, connected, threadId, reload]);
  const grants = read?.grants;
  if (grants === undefined) return null;
  const rows = grantRows(grants);
  const picker = threadId ? (
    <ApproveApp use={use} threadId={threadId} onApproved={() => setVersion((value) => value + 1)} />
  ) : null;
  if (rows.length === 0)
    return (
      <>
        {picker}
        <p className="py-2 text-sm text-muted-foreground">No approved apps.</p>
      </>
    );
  return (
    <>
      {picker}
      <ul aria-label="Approved apps" className="flex flex-col">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="group/setting flex h-9 items-center gap-2 border-b last:border-b-0"
          >
            <AppMark
              name={row.app}
              bundleId={row.bundleId}
              fallback={
                rows.findIndex((other) => other.bundleId === row.bundleId) === index
                  ? "group"
                  : "row"
              }
            />
            <p className="min-w-0 flex-1 truncate text-ui">
              {row.app}
              <span className="ml-2 text-xs text-subtle-foreground">
                {row.sensitive ? "Ask each turn" : row.scopeLabel}
              </span>
            </p>
            <RowMenu label={`Actions for ${row.app}`}>
              <MenuItem
                disabled={use.pending}
                onClick={() => void use.revoke(row).then(() => setVersion((value) => value + 1))}
              >
                Revoke
              </MenuItem>
            </RowMenu>
          </li>
        ))}
      </ul>
    </>
  );
}

const permissionNames = {
  screenRecording: {
    title: "Screen Recording",
    what: "See approved app windows.",
  },
  accessibility: {
    title: "Accessibility",
    what: "Control approved apps.",
  },
} as const;

/**
 * macOS grants to ace screen helper, each with Request (macOS asks, or opens its settings).
 * When they can't be read (computer use off, the helper refusing, the channel down) both say
 * Unavailable, with why and what to do next, instead of checking forever (QA-16).
 */
export function Permissions(props: { use: ComputerUse }) {
  const { use } = props;
  const { snapshot } = use;
  const note = useId();
  if (snapshot.unavailable)
    return (
      <EmptyState
        variant="inline"
        icon={MonitorIcon}
        title="No screen helper on ace on this machine."
        description="Computer use runs on a Mac with the ace desktop app installed."
      />
    );
  const reading = permissionsReading({
    connected: snapshot.connected,
    closed: snapshot.closed,
    enabled: snapshot.enabled,
    permissions: snapshot.permissions,
    problem: snapshot.permissionsProblem,
  });
  const recheck = (
    <button
      type="button"
      className="text-link focus-ring rounded-xs hover:underline disabled:opacity-40"
      disabled={use.pending}
      onClick={() => void use.refreshPermissions()}
    >
      Check again
    </button>
  );
  return (
    <div>
      {(["screenRecording", "accessibility"] as const).map((key) => {
        const granted = reading.state === "known" ? reading.permissions[key] : undefined;
        return (
          <SettingRow
            key={key}
            title={permissionNames[key].title}
            description={permissionNames[key].what}
            density="compact"
            inline
          >
            {granted !== true && granted !== false && (
              <StatusLabel
                tone="idle"
                label={reading.state === "checking" ? "Checking" : "Unavailable"}
              />
            )}
            {granted === false && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!snapshot.connected || use.pending}
                onClick={() => void use.requestPermission(key)}
              >
                Grant access
              </Button>
            )}
          </SettingRow>
        );
      })}
      {reading.state === "unavailable" ? (
        <p id={note} role="status" className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{reading.reason}.</span> {reading.next}{" "}
          {recheck}
        </p>
      ) : reading.state === "known" &&
        (!reading.permissions.screenRecording || !reading.permissions.accessibility) ? (
        <p className="mt-2 text-xs text-subtle-foreground">
          Granted it in System Settings? {recheck}
        </p>
      ) : null}
    </div>
  );
}
