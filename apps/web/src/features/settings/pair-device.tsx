import type { Device, DeviceScope } from "@ace/protocol";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { QrCode } from "@/components/ui/qr-code.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useSeconds } from "@/lib/time.ts";
import type { Pairing } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

type Access = "operate" | "read";
const accessOptions: { value: Access; label: string }[] = [
  { value: "operate", label: "View and act" },
  { value: "read", label: "View only" },
];
const accessLabels: Record<Access, string> = { operate: "Can view and act", read: "View only" };
const scopesFor: Record<Access, DeviceScope[]> = {
  operate: ["read", "operate"],
  read: ["read"],
};

/** While a code is on screen, the paired list is read this often to catch the new device. */
const watchMs = 2_000;

/** "m:ss" left on a pairing code. */
export function countdown(expiresAt: number, now: number): string {
  // `now` is whole seconds (the shared clock), so round down: a fresh code reads 10:00.
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Pair a phone or browser: pick its access, then a one-time QR code and link. While the code
 * shows, the paired list is watched; the new device replaces the code with a confirmation.
 */
export function PairDevice() {
  const backend = useSettingsBackend();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<Access>("operate");
  const [known, setKnown] = useState<ReadonlySet<string>>();
  const pair = useMutation({
    mutationFn: async (scopes: DeviceScope[]) => {
      // The devices paired before this code, so the one it pairs stands out.
      const before = await queries.fetchQuery({
        ...settingsQueries.devices(backend),
        staleTime: 0,
      });
      setKnown(new Set(before.map((device) => device.id)));
      return backend.pair(scopes);
    },
  });
  const pairing = pair.data;
  const devices = useQuery({
    ...settingsQueries.devices(backend),
    enabled: open && pairing !== undefined,
    refetchInterval: watchMs,
  });
  const paired = known && devices.data?.find((device) => !known.has(device.id));
  const reset = () => {
    pair.reset();
    setKnown(undefined);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        Pair
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            The code works once and expires after ten minutes. Pairing needs remote access to be on
            for this daemon.
          </DialogDescription>
        </DialogHeader>
        {paired ? (
          <Paired device={paired} onDone={() => setOpen(false)} />
        ) : pairing ? (
          <PairingCode
            pairing={pairing}
            access={access}
            onChange={reset}
            onRenew={() => pair.mutate(scopesFor[access])}
            onClose={() => setOpen(false)}
          />
        ) : (
          <>
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
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pair.isPending}
                onClick={() => pair.mutate(scopesFor[access])}
              >
                Show pairing code
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Paired(props: { device: Device; onDone(): void }) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);
  const access: Access = props.device.scopes.includes("operate") ? "operate" : "read";
  return (
    <>
      <div role="status" className="flex flex-col items-center gap-2 py-4 text-center">
        <Icon icon={CheckCircleIcon} size={36} className="text-status-done" />
        <p className="text-md font-medium">{props.device.name} paired</p>
        <p className="text-sm text-muted-foreground">{accessLabels[access]}</p>
      </div>
      <DialogFooter>
        <Button ref={done} variant="primary" onClick={props.onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function PairingCode(props: {
  pairing: Pairing;
  access: Access;
  onChange(): void;
  onRenew(): void;
  onClose(): void;
}) {
  const { pairing } = props;
  const toast = useToast();
  const now = useSeconds(true);
  const expired = pairing.expiresAt <= now;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairing.url);
      toast.add({ title: "Pairing link copied" });
    } catch {
      toast.error({ title: "Couldn't copy. Select the link and copy it yourself." });
    }
  };
  return (
    <>
      <div className="flex w-full min-w-0 flex-col items-center gap-3 text-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {accessLabels[props.access]}
          <Button size="sm" variant="ghost" onClick={props.onChange}>
            Change
          </Button>
        </p>
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
        <div className="flex w-full min-w-0 items-center gap-2">
          <Input
            readOnly
            aria-label="Pairing link"
            value={pairing.url}
            title={pairing.url}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 truncate font-mono text-xs"
          />
          {!expired && (
            <Button size="sm" onClick={() => void copy()}>
              Copy link
            </Button>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onClose}>
          Close
        </Button>
        {expired && (
          <Button variant="primary" onClick={props.onRenew}>
            New code
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
