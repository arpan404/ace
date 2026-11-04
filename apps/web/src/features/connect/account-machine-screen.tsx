import type { MachineCodeGate } from "@ace/client";
import { useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  versionMismatchWords,
  type ConnectionStatus,
  type DaemonConnection,
} from "@/boot/connection.tsx";
import { MachineCodePrompt } from "@/features/ace-account/index.ts";
import { ConnectCard } from "./connect-card.tsx";

/** The one sentence for how opening `name` through the ace account is going. */
function sentence(status: ConnectionStatus, name: string): string {
  switch (status.kind) {
    case "connecting":
    case "starting":
      return `Opening ${name} through your ace account…`;
    case "ready":
      return `${name} is open.`;
    case "unreachable":
      if (status.offline) return "This device is offline. ace connects once the network is back.";
      if (status.mismatch) return versionMismatchWords;
      return `Couldn't reach ${name} through ace's relay. Is it on, with ace running? ace keeps trying.`;
    case "editing":
      switch (status.problem) {
        case "signed_out":
          return `Sign in to your ace account to open ${name}.`;
        case "session_ended":
          return `Your ace session ended. Sign in again to open ${name}.`;
        case "not_on_account":
          return `${name} isn't on your ace account any more, or it turned this device away.`;
        case "machine_code":
          return "";
        case "protocol":
          return "This app couldn't read what ace sent. Try again; if it keeps happening, update ace here and on that computer.";
        case "storage":
          return "This window couldn't read the work it saved for this computer. Try again.";
        case undefined:
          return `${name} is on your ace account.`;
        default:
          return `ace closed the connection to ${name}. Try again.`;
      }
  }
}

/**
 * The connection screen for a machine on the person's ace account chosen as this window's
 * machine: how opening it is going, its machine code when its daemon asks, and a way on when it
 * can't open (sign in again, or choose another machine in the app with no machine).
 */
export function AccountMachineScreen(props: {
  connection: DaemonConnection;
  account: NonNullable<DaemonConnection["account"]>;
}) {
  const { connection, account } = props;
  const { status } = connection;
  const problem = status.kind === "editing" ? status.problem : undefined;
  const signIn = problem === "signed_out" || problem === "session_ended";
  // Trying again helps a machine out of reach or a dropped connection, not one that needs the
  // person: a sign-in, its code, or its place on the account.
  const retry =
    status.kind === "unreachable" ||
    (status.kind === "editing" &&
      !signIn &&
      problem !== "machine_code" &&
      problem !== "not_on_account");
  const said = sentence(status, account.name);
  const leave = connection.leave;
  return (
    <ConnectCard labelledBy="connect-title">
      <h1 id="connect-title" className="mt-4 text-xl font-semibold tracking-title">
        Open {account.name}
      </h1>
      {said && (
        <p
          role={problem ? "alert" : "status"}
          className="mt-1.5 mb-6 text-ui leading-normal text-muted-foreground"
        >
          {said}
        </p>
      )}
      {problem === "machine_code" && account.code && (
        <CodePrompt code={account.code} name={account.name} onEntered={connection.retry} />
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {signIn && leave && <Button onClick={() => leave("/settings/profile")}>Sign in</Button>}
        {retry && <Button onClick={connection.retry}>Try again</Button>}
        <Leave connection={connection}>Choose another computer</Leave>
      </div>
    </ConnectCard>
  );
}

/** The machine code field while the machine's daemon asks for it; its lock counts down. */
function CodePrompt(props: { code: MachineCodeGate; name: string; onEntered(): void }) {
  const { code } = props;
  const lockedUntil = useSyncExternalStore(code.subscribe, () => code.lockedUntil);
  return (
    <MachineCodePrompt
      gate={code}
      machine={props.name}
      lockedUntil={lockedUntil}
      onEntered={props.onEntered}
    />
  );
}

/** Back to the app with no machine, on Fleet; where the window can't run empty, Disconnect. */
function Leave(props: { connection: DaemonConnection; children: ReactNode }) {
  const { leave, disconnect } = props.connection;
  return (
    <Button variant="ghost" onClick={() => (leave ? leave("/settings/remote") : disconnect())}>
      {props.children}
    </Button>
  );
}
