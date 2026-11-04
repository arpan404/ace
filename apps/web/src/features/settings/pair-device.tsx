import { Navigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useAceAccount, useAceAccountStore } from "@/features/ace-account/index.ts";
import { PairingFlow } from "./pairing-flow.tsx";
import { SheetWays } from "./sheet-ways.tsx";

type Step = "choose" | "account" | "code";

/** Where a device opens ace's web app to sign in. */
const hostedApp = "app.acehq.dev";

/**
 * Pair a device: sign in on it with the same ace account (where this build has accounts), or
 * show a one-time pairing code (the same flow as `/pair`). `machine` picks the machine the code
 * pairs with to start with.
 */
export function PairDevice(props: { machine?: string; variant?: "secondary" | "ghost" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={props.variant ?? "secondary"} onClick={() => setOpen(true)}>
        Pair a device
      </Button>
      {open && <PairDeviceDialog machine={props.machine} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The pairing dialog, open while it's shown: the ways to add a device first, or straight on
 * the pairing code with `code` (where `/pair` lands).
 */
export function PairDeviceDialog(props: {
  machine?: string | undefined;
  code?: boolean;
  onClose(): void;
}) {
  const store = useAceAccountStore();
  const email = useAceAccount().session?.account.email;
  const [step, setStep] = useState<Step>(props.code || !store ? "code" : "choose");
  const flow = useRef<HTMLDivElement>(null);
  const close = props.onClose;
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent initialFocus={step === "code" ? flow : undefined}>
        <DialogHeader>
          <DialogTitle>
            {step === "choose" ? "Add a phone, tablet or browser" : "Pair a device"}
          </DialogTitle>
          {step === "choose" && (
            <DialogDescription>
              Devices watch your threads and steer agents. They never run agents themselves.
            </DialogDescription>
          )}
        </DialogHeader>
        {step === "choose" && (
          <>
            <SheetWays<"account" | "code">
              ways={[
                {
                  key: "account",
                  title: "Sign in on the device",
                  recommended: true,
                  sub: `Open ${hostedApp} and sign in${email ? ` with ${email}` : " with your ace account"}. Every machine on your account is there, from anywhere.`,
                },
                {
                  key: "code",
                  title: "Show a pairing code",
                  sub: "Scan the QR code or type the code on the device. Works without an account, on the same network or Tailscale.",
                },
              ]}
              onPick={(key) => setStep(key)}
            />
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
        {step === "account" && (
          <>
            <p className="text-ui text-muted-foreground">
              On the device, open{" "}
              <a
                href={`https://${hostedApp}`}
                target="_blank"
                rel="noreferrer"
                className="text-link hover:underline"
              >
                {hostedApp}
              </a>{" "}
              and sign in{email ? ` with ${email}` : " with the account this computer uses"}. This
              computer is there once it's signed in to the same account.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep("choose")}>
                Back
              </Button>
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
        {step === "code" && <PairingFlow ref={flow} machine={props.machine} close={close} />}
      </DialogContent>
    </Dialog>
  );
}

/** `/pair`: the pairing dialog, over Fleet where pairing lives. */
export function PairDevicePage() {
  return <Navigate to="/settings/remote" hash="pair" replace />;
}
