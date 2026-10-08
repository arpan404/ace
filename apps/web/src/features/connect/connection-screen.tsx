import { lazy, Suspense, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
const PairingForm = lazy(() =>
  import("./pairing-form.tsx").then((module) => ({ default: module.PairingForm })),
);
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
  auth: "This computer didn't accept the access token. Copy it again or create a new pairing link.",
  protocol: "These devices use different ace versions. Update ace on both and try again.",
  failed: "This computer closed the connection. Check its address, then try again.",
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
  const [pairing, setPairing] = useState(connection.pairingLink !== undefined);
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
        {pairing ? "Pair this device" : "Connect to your computer"}
      </h1>
      <p className="mt-1.5 mb-6 text-ui leading-normal text-muted-foreground">
        {pairing ? (
          "Give this device a name so you can recognize and revoke its access later."
        ) : connection.desktop ? (
          <>
            Connect to ace on another computer at a secure{" "}
            <code className="font-mono text-sm">wss://</code> address.
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
      {pairing ? (
        <Suspense fallback={null}>
          <PairingForm
            url={connection.url}
            link={connection.pairingLink}
            connect={(target, remember) => {
              setPairing(false);
              connection.connect(target, remember);
            }}
            cancel={() => setPairing(false)}
          />
        </Suspense>
      ) : (
        <>
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
          {!trying && (
            <Button variant="ghost" className="mt-4" onClick={() => setPairing(true)}>
              Have a pairing code?
            </Button>
          )}
        </>
      )}
    </ConnectCard>
  );
}

function alertFor(connection: DaemonConnection): ReactNode {
  const status = connection.status;
  if (status.kind === "editing") return status.problem && problems[status.problem];
  if (status.kind !== "unreachable") return undefined;
  if (status.offline) return "This device is offline. ace connects once the network is back.";
  const where = <code className="font-mono text-sm break-all">{connection.url}</code>;
  if (connection.desktop) return <>Couldn't reach ace at {where}. Is it running?</>;
  return (
    <>
      Couldn't reach {where}. Is ace running on that computer? Start it there with{" "}
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
