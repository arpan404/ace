import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SettingNote, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
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
 * one by address, or open one on the person's ace account. Pairing or connecting makes it this
 * window's machine the way the connection screen does, stored the same way.
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
      <SettingSection
        card
        label="Machines"
        note="This window isn't connected to a machine. Pair it with a computer running ace to start working there."
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setAdding("address")}>
              Connect by address
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding("pair")}>
              Pair a machine
            </Button>
          </>
        }
      >
        <AccountMachines />
      </SettingSection>
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
 * The machines on the person's ace account, each opened through ace's relay. Signed out, where
 * to sign in; a build without ace accounts says nothing.
 */
function AccountMachines() {
  const store = useAceAccountStore();
  const { session, restoring } = useAceAccount();
  const account = useAccountMachines(none);
  if (!store || restoring || account.loading) return null;
  if (!session)
    return (
      <SettingNote>
        <Link to="/settings/profile" className="text-foreground underline underline-offset-3">
          Sign in
        </Link>{" "}
        to open the machines on your ace account.
      </SettingNote>
    );
  return (
    <>
      {account.only.map((machine) => (
        <AccountMachineRow
          key={machine.hostId}
          machine={machine}
          onForget={(hostId) => account.forget.mutateAsync(hostId)}
        />
      ))}
      {account.error ? (
        <SettingNote role="alert">
          Couldn't list the machines on your ace account. Try again later.
        </SettingNote>
      ) : (
        account.only.length === 0 && <SettingNote>No machines on your ace account yet.</SettingNote>
      )}
    </>
  );
}
