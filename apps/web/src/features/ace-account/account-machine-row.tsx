import { useEffect, useState, useSyncExternalStore } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowAction, RowTile, StateWords } from "@/components/hairline-row.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { accountMachineLine, type AccountMachine } from "./account-machines.ts";
import { MachineCodePrompt } from "./machine-code-prompt.tsx";
import {
  useAccountMachineConnector,
  type AccountMachineConnection,
  type AccountMachineState,
} from "./machine-connector.ts";

const idle = () => () => {};

/**
 * A machine on the person's ace account that this window isn't connected to: its name,
 * platform and last seen. The row opens it (through ace's relay, asking for its machine code
 * here when it has one); Forget takes it off the account's list until it signs in again.
 */
export function AccountMachineRow(props: {
  machine: AccountMachine;
  onForget(hostId: string): Promise<void>;
  /**
   * Opens it some other way than beside this window's machine: a window with no machine makes
   * it its own (the connection gate then says how opening it goes).
   */
  onOpen?: ((machine: AccountMachine) => void) | undefined;
}) {
  const { machine } = props;
  const now = useNow();
  const toast = useToast();
  const connector = useAccountMachineConnector();
  const [connection, setConnection] = useState<AccountMachineConnection>();
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState<Confirming>();
  // An opened machine joins the pool and lists as a connected one, which unmounts this row; only
  // an attempt that never opened is closed when the row goes.
  useEffect(
    () => () => {
      if (connection && connection.get().kind !== "open") void connection.close().catch(() => {});
    },
    [connection],
  );
  const state = useSyncExternalStore<AccountMachineState | undefined>(
    connection?.subscribe ?? idle,
    () => connection?.get(),
  );
  const open = () => {
    if (props.onOpen) return props.onOpen(machine);
    if (connection) return connection.retry();
    if (!connector || opening) return;
    setOpening(true);
    setProblem("");
    connector
      .connect({ hostId: machine.hostId, name: machine.name, platform: machine.platform })
      .then(setConnection, (error: unknown) =>
        setProblem(error instanceof Error ? error.message : "Couldn't open it. Try again."),
      )
      .finally(() => setOpening(false));
  };
  const asking = connection !== undefined && state?.kind === "asking";
  const line = opening
    ? { tone: "off" as const, words: "Opening…" }
    : problem
      ? { tone: "warn" as const, words: problem }
      : state?.kind === "connecting"
        ? { tone: "off" as const, words: "Opening…" }
        : state?.kind === "open"
          ? { tone: "on" as const, words: "Online" }
          : state?.kind === "failed"
            ? { tone: "warn" as const, words: state.message }
            : asking
              ? { tone: "warn" as const, words: "Asks for its machine code" }
              : {
                  tone: "off" as const,
                  words: `On your ace account · ${accountMachineLine(machine, now)}`,
                };
  const canOpen =
    (props.onOpen || connector) && !opening && (state === undefined || state.kind === "failed");
  return (
    <HairlineRow
      data-row="account-machine"
      tile={
        <RowTile>
          <MachineMark primary={false} decorative size={15} />
        </RowTile>
      }
      title={machine.name}
      label={`Open ${machine.name}`}
      {...(canOpen ? { onOpen: open } : {})}
      sub={
        <span role={state || opening || problem ? "status" : undefined}>
          <StateWords tone={line.tone}>{line.words}</StateWords>
        </span>
      }
      actions={
        <RowAction
          reveal
          aria-label={`Forget ${machine.name}`}
          onClick={() =>
            setConfirming({
              title: `Forget ${machine.name}?`,
              body: "It leaves your ace account's machines until it signs in to the account again.",
              confirm: "Forget",
              run: () =>
                void props.onForget(machine.hostId).catch((error: unknown) =>
                  toast.error({
                    title: "Couldn't forget it",
                    description: error instanceof Error ? error.message : undefined,
                  }),
                ),
            })
          }
        >
          Forget
        </RowAction>
      }
    >
      {connection && asking && (
        <div className="pb-3 pl-10">
          <MachineCodePrompt
            gate={connection.gate}
            machine={machine.name}
            lockedUntil={state.lockedUntil}
            onEntered={() => connection.retry()}
          />
        </div>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </HairlineRow>
  );
}
