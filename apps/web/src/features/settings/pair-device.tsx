import type { DeviceScope } from "@ace/protocol";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { QrCode } from "@/components/ui/qr-code.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Pairing } from "./data/backend.ts";
import { useSettingsBackend } from "./data/use-settings.ts";

type Access = "operate" | "read";
const accessOptions: { value: Access; label: string }[] = [
  { value: "operate", label: "View and act" },
  { value: "read", label: "View only" },
];
const scopesFor: Record<Access, DeviceScope[]> = {
  operate: ["read", "operate"],
  read: ["read"],
};

/** "m:ss" left on a pairing code. */
export function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Seconds since this view mounted, ticking while it is on screen. */
function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Pair a phone or browser: pick its access, then show a one-time QR code and link. */
export function PairDevice() {
  const backend = useSettingsBackend();
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<Access>("operate");
  const pair = useMutation({ mutationFn: (scopes: DeviceScope[]) => backend.pair(scopes) });
  const pairing = pair.data;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) pair.reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        Pair
      </Button>
      <DialogContent className="w-[min(420px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            The code works once and expires after ten minutes. Pairing needs remote access to be on
            for this daemon.
          </DialogDescription>
        </DialogHeader>
        {!pairing && (
          <div className="flex flex-col items-start gap-4">
            <SegmentedControl<Access>
              label="Access"
              value={access}
              options={accessOptions}
              onValueChange={setAccess}
            />
            {pair.isError && (
              <p role="alert" className="text-sm text-destructive">
                {pair.error.message}
              </p>
            )}
            <Button
              variant="primary"
              disabled={pair.isPending}
              onClick={() => pair.mutate(scopesFor[access])}
            >
              Show pairing code
            </Button>
          </div>
        )}
        {pairing && (
          <PairingCode pairing={pairing} onRenew={() => pair.mutate(scopesFor[access])} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PairingCode(props: { pairing: Pairing; onRenew(): void }) {
  const { pairing } = props;
  const toast = useToast();
  const now = useSecondClock();
  const expired = pairing.expiresAt <= now;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairing.url);
      toast.add({ title: "Pairing link copied" });
    } catch {
      toast.add({ title: "Couldn't copy. Select the link and copy it yourself." });
    }
  };
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <QrCode
        value={pairing.url}
        label="Pairing QR code"
        {...(expired ? { className: "opacity-20" } : {})}
      />
      <p className="font-mono text-lg tracking-[0.12em]" aria-label="Pairing code">
        {pairing.code}
      </p>
      <p className="text-sm text-muted-foreground">
        {expired ? "This code has expired." : `Expires in ${countdown(pairing.expiresAt, now)}`}
      </p>
      <p className="max-w-full truncate font-mono text-[11.5px] text-subtle-foreground">
        {pairing.url}
      </p>
      {expired ? (
        <Button variant="primary" onClick={props.onRenew}>
          New code
        </Button>
      ) : (
        <Button onClick={() => void copy()}>Copy link</Button>
      )}
    </div>
  );
}
