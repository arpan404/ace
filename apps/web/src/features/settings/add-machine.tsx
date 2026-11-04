import type { MachinePool } from "@ace/client-worker/machines";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useEnsureMachinePool, useMachinePool } from "@/lib/machine-pool.ts";
import { readPairedMachine } from "@/boot/pair-machine.ts";
import { PairingForm } from "@/features/connect/index.ts";
import { useAceAccount, useAceAccountStore } from "@/features/ace-account/index.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { SheetWays, type Way } from "./sheet-ways.tsx";

type AddWay = "account" | "code" | "address";

const titles: Record<AddWay | "choose", string> = {
  choose: "Add a machine",
  account: "Sign in there",
  code: "Pair with a code",
  address: "Connect by address",
};

/**
 * Add another computer running ace: sign in there with the same ace account (it then lists on
 * its own), or pair this window with it using a link or code, typed with its address when
 * there's no link. `onAdded` gets the paired machine's host id once it's in the directory.
 */
export function AddMachine(props: { onClose(): void; onAdded?(hostId: string): void }) {
  const store = useAceAccountStore();
  const email = useAceAccount().session?.account.email;
  const [way, setWay] = useState<AddWay | "choose">("choose");
  const ways: Way<AddWay>[] = [
    ...(store
      ? [
          {
            key: "account" as const,
            title: "Sign in there",
            recommended: true,
            sub: `Sign in to ace on that computer${email ? ` with ${email}` : " with your ace account"}. It shows up here on its own and works from anywhere.`,
          },
        ]
      : []),
    {
      key: "code",
      title: "Pair with a code",
      sub: "On that computer open Fleet › Pair a device, then enter its link or code here. For a machine that isn't on your account.",
    },
    {
      key: "address",
      title: "Connect by address",
      sub: "Type its local or Tailscale address and the code it gives. For machines you manage by hand.",
    },
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[way]}</DialogTitle>
          {way === "choose" && (
            <DialogDescription>
              Install ace on the other computer first, then pick how this window should reach it.
            </DialogDescription>
          )}
        </DialogHeader>
        {way === "choose" ? (
          <>
            <SheetWays<AddWay> ways={ways} onPick={(key) => setWay(key)} />
            <DialogFooter>
              <Button variant="secondary" onClick={props.onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : way === "account" ? (
          <SignInThere email={email} onDone={props.onClose} onBack={() => setWay("choose")} />
        ) : (
          <PairThere way={way} onClose={props.onClose} onAdded={props.onAdded} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SignInThere(props: { email: string | undefined; onDone(): void; onBack(): void }) {
  return (
    <>
      {props.email ? (
        <p className="text-ui text-muted-foreground">
          On the other computer, open ace and sign in with {props.email}. It appears under Machines
          here once it's signed in, and opens from anywhere through ace's relay.
        </p>
      ) : (
        <p className="text-ui text-muted-foreground">
          Sign in to your ace account here first, under Profile. Then sign in on the other computer
          with the same account.
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={props.onBack}>
          Back
        </Button>
        {props.email ? (
          <Button variant="primary" onClick={props.onDone}>
            Done
          </Button>
        ) : (
          <Button variant="primary" render={<Link to="/settings/profile" />}>
            Open Profile
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function PairThere(props: {
  way: "code" | "address";
  onClose(): void;
  onAdded?: ((hostId: string) => void) | undefined;
}) {
  const pool = useMachinePool();
  const ensure = useEnsureMachinePool();
  return (
    <>
      <DialogDescription>
        {props.way === "code" ? (
          <>
            On the other computer open Settings › Fleet › Pair a device, choose Administrator access
            and create a link. Paste the link here, or type its code and address.
          </>
        ) : (
          <>
            Type its address, and the code{" "}
            <code className="font-mono text-xs">ace pair read,operate,admin</code> prints there.
          </>
        )}
      </DialogDescription>
      <PairingForm
        url=""
        submitLabel="Add machine"
        renderActions={(actions) => <DialogFooter>{actions}</DialogFooter>}
        cancel={props.onClose}
        connect={async (target, remember, signal) => {
          const chosen: MachinePool | undefined = pool ?? (await ensure?.());
          if (!chosen)
            throw new Error("Couldn't open your machine directory. Reconnect and try again.");
          signal.throwIfAborted();
          const entry = await chosen.pair(target.url, () =>
            readPairedMachine(target, remember, signal),
          );
          props.onAdded?.(entry.hostId);
          props.onClose();
        }}
      />
    </>
  );
}
