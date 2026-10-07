import type { ReactNode } from "react";
import {
  useDaemonConnection,
  type ConnectionProblem,
  type DaemonConnection,
} from "@/boot/connection.tsx";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { CopyCommand } from "@/components/copy-command.tsx";
import { ConnectCard } from "./connect-card.tsx";
import { DaemonForm } from "./daemon-form.tsx";
import { HandoffScreen } from "./handoff-screen.tsx";

const problems: Record<ConnectionProblem, ReactNode> = {
  auth: "The daemon didn't accept this token. It changes when the daemon's home is reset; copy it again.",
  protocol: "This app and the daemon are different versions. Update ace on one of them.",
  failed: "The daemon closed the connection. Check the address, then try again.",
};

/**
 * Shown when this window has no daemon to talk to, while it tries the one it was given, or
 * when a link asks to switch to one it can't vouch for. The app mounts only once a daemon has
 * welcomed it. ace never runs providers itself: the daemon on the person's machine drives
 * their installed CLIs.
 */
export function ConnectionScreen() {
  useDismissBootSplash();
  const connection = useDaemonConnection();
  const handoff = connection.handoff;
  if (handoff)
    return (
      <HandoffScreen
        url={handoff.url}
        reason={handoff.reason}
        keepsCurrent={connection.remembered}
        onConnect={handoff.accept}
        onDecline={handoff.decline}
      />
    );
  const status = connection.status;
  const trying = status.kind === "connecting" || status.kind === "unreachable";
  return (
    <ConnectCard labelledBy="connect-title">
      <h1 id="connect-title" className="mt-4 text-xl font-semibold tracking-title">
        Connect to your daemon
      </h1>
      <p className="mt-1.5 mb-6 text-ui leading-normal text-muted-foreground">
        {connection.desktop ? (
          <>
            This computer doesn't run ace's daemon itself. Connect to one on another machine at a
            secure <code className="font-mono text-sm">wss://</code> address.
          </>
        ) : (
          <>
            ace runs on your machine and drives the coding CLIs you already use. Start it with{" "}
            <code className="rounded-xs bg-secondary px-1 font-mono text-sm whitespace-nowrap text-foreground">
              ace start
            </code>
            , then point this window at it.
          </>
        )}
      </p>
      <DaemonForm
        url={connection.url}
        token={connection.token}
        remembered={connection.remembered}
        submitLabel="Connect"
        onSubmit={connection.connect}
        readOnly={trying}
        wide
        selectToken={status.kind === "editing" && status.problem === "auth"}
        alert={alertFor(connection)}
        {...buttonsFor(connection)}
      />
    </ConnectCard>
  );
}

function alertFor(connection: DaemonConnection): ReactNode {
  const status = connection.status;
  if (status.kind === "editing") return status.problem && problems[status.problem];
  if (status.kind !== "unreachable") return undefined;
  if (status.offline) return "This device is offline. ace connects once the network is back.";
  const where = <code className="font-mono text-sm break-all">{connection.url}</code>;
  if (connection.desktop) return <>Couldn't reach the daemon at {where}. Is it running?</>;
  return (
    <>
      Couldn't reach {where}. Is the daemon running on that machine? Start it there with{" "}
      <CopyCommand command="ace start" />
    </>
  );
}

function buttonsFor(connection: DaemonConnection) {
  const status = connection.status;
  if (status.kind === "connecting")
    return {
      pending: true,
      primary: { label: "Connecting…", run: () => {} },
      secondary: { label: "Cancel", run: connection.edit },
    };
  if (status.kind === "unreachable")
    return {
      primary: { label: "Try again", run: connection.retry },
      secondary: { label: "Edit", run: connection.edit },
    };
  return {};
}
