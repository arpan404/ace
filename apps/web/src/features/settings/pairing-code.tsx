import { CheckCircleIcon } from "@phosphor-icons/react";
import type { Device } from "@ace/protocol";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { DialogFooter } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { QrCode } from "@/components/ui/qr-code.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { useSeconds } from "@/lib/time.ts";
import { deviceScopeLabels } from "./device-scopes.ts";

/** A link a machine issued: what the phone scans, the code typed by hand, and when it lapses. */
export interface IssuedPairing {
  url: string;
  code: string;
  expiresAt: number;
}

/** "m:ss" left on a pairing code, or hours and days for a longer link. */
export function countdown(expiresAt: number, now: number): string {
  // `now` is whole seconds (the shared clock), so round down: a fresh code reads 5:00.
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    return hours >= 48
      ? `${Math.floor(hours / 24)} days`
      : `${hours} h ${Math.floor((seconds % 3600) / 60)} min`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Paired(props: { device: Device; onDone(): void }) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);

  return (
    <>
      <div role="status" className="fx-rise-in flex flex-col items-center gap-2 py-4 text-center">
        <Icon icon={CheckCircleIcon} size={36} className="text-status-done" />
        <p className="text-md font-medium">{props.device.name} paired</p>
        <p className="text-sm text-muted-foreground">{deviceScopeLabels(props.device.scopes)}</p>
      </div>
      <DialogFooter>
        <Button ref={done} variant="primary" onClick={props.onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

export function PairingCode(props: {
  pairing: IssuedPairing;
  /** How long the link was made to last, for the bar under the code. */
  lifeMs: number;
  /** What the link grants, in one line above the code. */
  summary: string;
  onChange(): void;
  onRenew(): void;
  onClose(): void;
}) {
  const { pairing } = props;
  const toast = useToast();
  const now = useSeconds(true);
  const expired = pairing.expiresAt <= now;
  const left = pairing.expiresAt - now;
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the link and copy it yourself." }),
  );
  return (
    <>
      <div className="fx-rise-in flex w-full min-w-0 flex-col gap-3">
        <p className="flex items-center gap-1 text-ui text-muted-foreground">
          {props.summary}
          <span aria-hidden>·</span>
          <Button size="sm" variant="ghost" className="-ml-1.5" onClick={props.onChange}>
            Change
          </Button>
        </p>
        <div className="flex flex-col items-center gap-3 py-3">
          <div className="relative">
            <QrCode
              value={pairing.url}
              label="Pairing QR code"
              className={cn(
                "shadow-[0_0_0_1px_rgb(0_0_0/0.06)] transition-opacity duration-(--motion-base)",
                expired && "opacity-15",
              )}
            />
            {expired && (
              <span className="absolute inset-0 grid place-items-center text-ui font-medium">
                Expired
              </span>
            )}
          </div>
          {pairing.code.length > 12 ? (
            // A long code wraps in groups of four, as wide as the QR, like a fingerprint.
            <p
              aria-label={`Pairing code ${pairing.code}`}
              className="grid w-44 grid-cols-4 justify-items-center font-mono text-xs leading-5 text-muted-foreground tabular-nums"
            >
              {pairing.code.match(/.{1,4}/g)?.map((group, index) => (
                <span key={index}>{group}</span>
              ))}
            </p>
          ) : (
            <p
              aria-label={`Pairing code ${pairing.code}`}
              className="font-mono text-lg font-semibold tracking-[0.14em] tabular-nums"
            >
              {pairing.code}
            </p>
          )}
          <div className="h-[3px] w-44 overflow-hidden rounded-full bg-fill-strong">
            <span
              className="block h-full rounded-full bg-ring transition-[width] duration-1000 ease-linear"
              style={{ width: `${Math.max(0, Math.min(1, left / props.lifeMs)) * 100}%` }}
            />
          </div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {expired ? (
              "This code has expired."
            ) : (
              <>
                <Spinner label="Waiting for the device" />
                {`Waiting for your device · Expires in ${countdown(pairing.expiresAt, now)}`}
              </>
            )}
          </p>
        </div>
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
            <Button size="sm" onClick={() => copy(pairing.url)}>
              {copied ? "Copied" : "Copy link"}
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
