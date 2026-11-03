import { useEffect, useState, useSyncExternalStore } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
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
 * platform and last seen, Open (through ace's relay, asking for its machine code here when it
 * has one) and Forget, which takes it off the account's list until it signs in again.
 */
export function AccountMachineRow(props: {
  machine: AccountMachine;
  onForget(hostId: string): Promise<void>;
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
  const line = opening
    ? "Opening…"
    : problem
      ? problem
      : state?.kind === "connecting"
        ? "Opening…"
        : state?.kind === "open"
          ? "Connected"
          : state?.kind === "failed"
            ? state.message
            : accountMachineLine(machine, now);
  return (
    <div data-account-machine="" className="group/setting">
      <div className="flex min-h-(--setting-row-height) items-center gap-3 py-(--setting-row-y)">
        <MachineMark primary={false} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-md text-foreground">{machine.name}</span>
          <span
            role={state || opening || problem ? "status" : undefined}
            className="text-xs text-muted-foreground"
          >
            {line}
          </span>
        </div>
        {connector && !opening && (state === undefined || state.kind === "failed") && (
          <Button size="sm" variant="ghost" className="-mr-1" onClick={open}>
            Open
          </Button>
        )}
        <RowMenu label={`Actions for ${machine.name}`}>
          <MenuItem
            danger
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
          </MenuItem>
        </RowMenu>
      </div>
      {connection && state?.kind === "asking" && (
        <div className="pl-9">
          <MachineCodePrompt
            gate={connection.gate}
            machine={machine.name}
            lockedUntil={state.lockedUntil}
            onEntered={() => connection.retry()}
          />
        </div>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}
