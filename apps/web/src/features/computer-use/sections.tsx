import {
  targetBundle,
  permissionsReading,
  visibleSessions,
  requirementStatus,
} from "@ace/ui-core/computer-use";
import { MonitorIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { SessionCard } from "./session-card.tsx";
import type { ComputerUse } from "./use-computer-use.ts";

/** Why a machine opened through the ace account has no computer use here. */
const throughAccountWords =
  "Opened through your ace account, which doesn't carry computer use yet. Pair this device with the machine to let agents use apps there.";

/** Computer use on or off: off stops every session and keeps agents from starting one. */
export function EnableRow(props: { use: ComputerUse }) {
  const { use } = props;
  const id = useId();
  const { snapshot } = use;
  const description = snapshot.throughAccount
    ? throughAccountWords
    : snapshot.unavailable
      ? "ace on this machine has no screen helper, so agents can't use apps here."
      : !snapshot.connected
        ? "Connecting to the screen helper…"
        : "Their provider's permission mode approves each action.";
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
  if (use.snapshot.throughAccount)
    return <p className="py-2 text-sm text-muted-foreground">{throughAccountWords}</p>;
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

const permissionNames = {
  screenRecording: {
    title: "Screen Recording",
    what: "See app windows.",
  },
  accessibility: {
    title: "Accessibility",
    what: "Control apps.",
  },
} as const;

/**
 * macOS grants to ace screen helper, each with status and an action opening System Settings.
 * When they can't be read (computer use off, the helper refusing, the channel down) both say
 * Unavailable, with why and what to do next, instead of checking forever (QA-16).
 */
export function Permissions(props: { use: ComputerUse }) {
  const { use } = props;
  const { snapshot } = use;
  const note = useId();
  if (snapshot.throughAccount)
    return <SettingNote>Not available through your ace account.</SettingNote>;
  if (snapshot.unavailable)
    return (
      <EmptyState
        variant="inline"
        icon={MonitorIcon}
        title="No screen helper on ace on this machine."
        description="Computer use needs ace's screen helper, which comes with the ace desktop app and ace's macOS, Linux and Windows releases."
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
  if (snapshot.permissions?.requirements) {
    return (
      <>
        {snapshot.permissions.requirements.map((requirement) => {
          const status = requirementStatus(requirement.state);
          const permission = requirement.permission;
          return (
            <SettingRow
              key={requirement.kind}
              title={requirement.title}
              description={requirement.message}
              density="compact"
            >
              <StatusLabel tone={status.ready ? "done" : "idle"} label={status.label} />
              {permission && requirement.action && !status.ready && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!snapshot.connected || use.pending}
                  onClick={() => void use.requestPermission(permission)}
                >
                  {requirement.action}
                </Button>
              )}
            </SettingRow>
          );
        })}
        <SettingNote>{recheck}</SettingNote>
      </>
    );
  }
  return (
    <>
      {(["screenRecording", "accessibility"] as const).map((key) => {
        const granted = reading.state === "known" ? reading.permissions[key] : undefined;
        return (
          <SettingRow
            key={key}
            title={permissionNames[key].title}
            description={permissionNames[key].what}
            density="compact"
          >
            <StatusLabel
              tone={granted === true ? "done" : "idle"}
              label={
                granted === true
                  ? "Granted"
                  : granted === false
                    ? "Not granted"
                    : reading.state === "checking"
                      ? "Checking"
                      : "Unavailable"
              }
            />
            {typeof granted === "boolean" && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!snapshot.connected || use.pending}
                aria-label={`${granted ? "Revoke" : "Grant"} ${permissionNames[key].title} access`}
                onClick={() => void use.requestPermission(key)}
              >
                {granted ? "Revoke access…" : "Grant access"}
              </Button>
            )}
          </SettingRow>
        );
      })}
      {reading.state === "unavailable" ? (
        <SettingNote id={note} role="status">
          <span className="font-medium text-foreground">{reading.reason}.</span> {reading.next}{" "}
          {recheck}
        </SettingNote>
      ) : reading.state === "known" ? (
        <SettingNote>
          Grant or revoke access for Ace Screen Helper in System Settings. {recheck}
        </SettingNote>
      ) : null}
    </>
  );
}
