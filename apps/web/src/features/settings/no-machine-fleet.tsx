import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DesktopTowerIcon, GlobeIcon } from "@phosphor-icons/react";
import { HairlineRow, RowAction, RowGroup, RowTile } from "@/components/hairline-row.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import {
  AccountMachineRow,
  useAceAccount,
  useAceAccountStore,
  useAccountMachines,
} from "@/features/ace-account/index.ts";
import { DaemonForm, PairingForm } from "@/features/connect/index.ts";

const none: readonly { id: string }[] = [];

/**
 * Fleet in a window with no machine: pair this window with a computer running ace, connect to
 * one by address, or open one on the person's ace account. Each makes it this window's machine
 * the way the connection screen does, kept for a reload.
 */
export function NoMachineFleetPage(props: { pairing?: boolean | undefined }) {
  const connection = useDaemonConnection();
  const navigate = useNavigate();
  const [adding, setAdding] = useState<"pair" | "address" | undefined>(
    props.pairing ? "pair" : undefined,
  );
  const close = () => setAdding(undefined);
  const connect = (target: DaemonTarget, remember: boolean) => {
    close();
    // The window opens on its machine's home, not on this page's address (`/pair` would ask
    // the machine to create a pairing).
    void navigate({ to: "/", replace: true });
    connection.connect(target, remember);
  };
  return (
    <>
      <RowGroup label="Machines" anchor="fleet.link">
        <AccountMachines />
      </RowGroup>
      <RowGroup label="Add a machine">
        <HairlineRow
          tile={
            <RowTile>
              <DesktopTowerIcon aria-hidden size={15} />
            </RowTile>
          }
          title="Pair with a code"
          sub="On the computer running ace open Settings › Fleet › Pair a device, then enter its link or code here."
          actions={
            <RowAction className="text-foreground" onClick={() => setAdding("pair")}>
              Pair a machine
            </RowAction>
          }
        />
        <HairlineRow
          tile={
            <RowTile>
              <GlobeIcon aria-hidden size={15} />
            </RowTile>
          }
          title="Connect by address"
          sub="Type the address of ace on that computer and its access token."
          actions={
            <RowAction className="text-foreground" onClick={() => setAdding("address")}>
              Connect by address
            </RowAction>
          }
        />
      </RowGroup>
      <Dialog
        open={adding !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          {adding === "pair" ? (
            <>
              <DialogHeader>
                <DialogTitle>Pair a machine</DialogTitle>
                <DialogDescription>
                  On the computer running ace, open Settings › Fleet › Pair a device, then paste its
                  link or code here.
                </DialogDescription>
              </DialogHeader>
              <PairingForm url={connection.url} connect={connect} cancel={close} />
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Connect by address</DialogTitle>
                <DialogDescription>
                  The address of ace on that computer and its access token.
                </DialogDescription>
              </DialogHeader>
              <DaemonForm
                url={connection.url}
                remembered={connection.remembered}
                submitLabel="Connect"
                onSubmit={connect}
                secondary={{ label: "Cancel", run: close }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The machines on the person's ace account, each opened through ace's relay as this window's
 * machine. Signed out, where to sign in; a build without ace accounts says nothing.
 */
function AccountMachines() {
  const store = useAceAccountStore();
  const { session, restoring } = useAceAccount();
  const account = useAccountMachines(none);
  const connection = useDaemonConnection();
  const navigate = useNavigate();
  const origin = store?.origin;
  const openAccount = connection.openAccount;
  // Opening one makes it this window's machine; the window then opens on its home.
  const open =
    openAccount && origin
      ? (machine: { hostId: string; name: string }) => {
          void navigate({ to: "/", replace: true });
          openAccount({
            origin,
            hostId: machine.hostId,
            name: machine.name,
            // The account it is chosen on, so another account's window says where it is.
            ...(session ? { accountId: session.account.id } : {}),
          });
        }
      : undefined;
  if (!store || restoring || account.loading) return null;
  if (!session)
    return (
      <p className="py-3 text-xs text-muted-foreground">
        <Link to="/settings/profile" className="text-foreground underline underline-offset-3">
          Sign in
        </Link>{" "}
        to open the machines on your ace account.
      </p>
    );
  return (
    <>
      {account.only.map((machine) => (
        <AccountMachineRow
          key={machine.hostId}
          machine={machine}
          onForget={(hostId) => account.forget.mutateAsync(hostId)}
          onOpen={open}
        />
      ))}
      {account.error ? (
        <p role="alert" className="py-3 text-xs text-muted-foreground">
          Couldn't list the machines on your ace account. Try again later.
        </p>
      ) : (
        account.only.length === 0 && (
          <p className="py-3 text-xs text-muted-foreground">No machines on your ace account yet.</p>
        )
      )}
    </>
  );
}
