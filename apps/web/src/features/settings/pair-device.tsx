import { SettingAddRow, SettingDisclosure } from "@/components/setting-row.tsx";
import { Navigate, useLocation } from "@tanstack/react-router";
import { Switch } from "@/components/ui/switch.tsx";
import { deviceScopeLabels, deviceAccessOptions } from "./device-scopes.ts";
import type { Device, DeviceScope } from "@ace/protocol";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { QrCode } from "@/components/ui/qr-code.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useSeconds } from "@/lib/time.ts";
import type { Pairing } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend, useRemoteStatus } from "./data/use-settings.ts";

type Access = "operate" | "read" | "admin";
const scopesFor: Record<Access, DeviceScope[]> = {
  operate: ["read", "operate"],
  read: ["read"],
  admin: ["read", "operate", "admin"],
};

/** While a code is on screen, the paired list is read this often to catch the new device. */
const watchMs = 2_000;
/** How long a pairing code lives: the bar under the QR drains over it. */
const codeLifeMs = 5 * 60_000;

const accessDescriptions: Record<Access, string> = {
  operate: "Follow threads, answer approvals and send messages.",
  read: "Follow threads and read transcripts.",
  admin: "Everything, plus settings, pairing and computer use.",
};

/** Grants apart from the access level, each its own switch. */
const advancedScopes: readonly { value: "projects" | "accounts"; label: string; what: string }[] = [
  { value: "projects", label: "Projects", what: "Add and remove project folders." },
  { value: "accounts", label: "Accounts", what: "Add and remove provider accounts." },
];

/** One access level to pair with: its name and what it allows, chosen as a whole card. */
function AccessOption(props: {
  label: string;
  description: string;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-label={props.label}
      onClick={props.onSelect}
      className="flex w-full items-start gap-3 py-2.5 text-left focus-ring-inset"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          props.selected ? "border-ring" : "border-border-strong",
        )}
      >
        {props.selected && <span className="fx-rise-in size-2 rounded-full bg-ring" />}
      </span>
      <span className="min-w-0">
        <span className="block text-ui font-medium text-foreground">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </button>
  );
}

/** "m:ss" left on a pairing code. */
export function countdown(expiresAt: number, now: number): string {
  // `now` is whole seconds (the shared clock), so round down: a fresh code reads 5:00.
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Pair a phone or browser: pick its access, then a one-time QR code and link. While the code
 * shows, the paired list is watched; the new device replaces the code with a confirmation.
 */
function PairingFlow({ ref, ...props }: { close(): void; ref: Ref<HTMLDivElement> }) {
  const id = useId();
  const backend = useSettingsBackend();
  const remote = useRemoteStatus();
  const reachable =
    !remote.isFetching &&
    remote.data?.enabled &&
    ["lan", "tailscale"].includes(remote.data.transport);
  const queries = useQueryClient();
  const [access, setAccess] = useState<Access>("operate");
  const [advanced, setAdvanced] = useState<DeviceScope[]>([]);
  const granted = [...scopesFor[access], ...advanced];
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
    enabled: pairing !== undefined,
    refetchInterval: watchMs,
  });
  const paired = known && devices.data?.find((device) => !known.has(device.id));
  const reset = () => {
    pair.reset();
    setKnown(undefined);
  };
  return (
    // Focus starts on the flow itself, not on the first option: nothing is outlined until the
    // person presses a key.
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <p className="text-sm text-muted-foreground">
        The link works once and expires after five minutes.{" "}
        {remote.isFetching
          ? "Checking remote access…"
          : reachable
            ? `Connect your device to ${remote.data?.transport === "tailscale" ? "your Tailscale network" : "the same local network"} to pair.`
            : remote.isError
              ? "Couldn't check remote access. Reconnect and try again."
              : !remote.data
                ? "Checking remote access…"
                : "Turn on LAN or Tailscale access before pairing."}
      </p>
      {paired ? (
        <Paired device={paired} onDone={() => props.close()} />
      ) : pairing ? (
        <PairingCode
          pairing={pairing}
          access={access}
          scopes={granted}
          onChange={reset}
          onRenew={() => pair.mutate(granted)}
          onClose={() => props.close()}
        />
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label="Access"
            className="flex flex-col divide-y divide-border border-y border-border"
          >
            {deviceAccessOptions.map((option) => (
              <AccessOption
                key={option.value}
                label={option.label}
                description={accessDescriptions[option.value]}
                selected={access === option.value}
                onSelect={() => setAccess(option.value)}
              />
            ))}
          </div>
          <SettingDisclosure title="Advanced access">
            <div className="divide-y divide-border">
              {advancedScopes.map((scope) => (
                <div
                  key={scope.value}
                  className="flex min-h-11 items-center justify-between gap-4 py-1.5"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <label htmlFor={`${id}-${scope.value}`} className="text-ui text-foreground">
                      {scope.label}
                    </label>
                    <span className="text-xs text-muted-foreground">{scope.what}</span>
                  </span>
                  <Switch
                    id={`${id}-${scope.value}`}
                    checked={advanced.includes(scope.value)}
                    onCheckedChange={(on) =>
                      setAdvanced((before) =>
                        on
                          ? [...before, scope.value]
                          : before.filter((item) => item !== scope.value),
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </SettingDisclosure>
          {pair.isError && (
            <p role="alert" className="text-sm text-destructive">
              {pair.error.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => props.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pair.isPending || !reachable}
              onClick={() => pair.mutate(granted)}
            >
              Show pairing code
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  );
}

/** Machines and devices' add row opens the same flow as /pair. */
export function PairDevice() {
  // `/pair` lands here with #pair: the dialog opens over the page it belongs to.
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(hash === "pair");
  const flow = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SettingAddRow id="remote.pair" onClick={() => setOpen(true)}>
        Pair a device
      </SettingAddRow>
      <DialogContent initialFocus={flow}>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
        </DialogHeader>
        {open && <PairingFlow ref={flow} close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** `/pair`: the pairing dialog, over Machines and devices where pairing lives. */
export function PairDevicePage() {
  return <Navigate to="/settings/remote" hash="pair" replace />;
}

function Paired(props: { device: Device; onDone(): void }) {
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

function PairingCode(props: {
  pairing: Pairing;
  access: Access;
  scopes: DeviceScope[];
  onChange(): void;
  onRenew(): void;
  onClose(): void;
}) {
  const { pairing } = props;
  const toast = useToast();
  const now = useSeconds(true);
  const expired = pairing.expiresAt <= now;
  const left = pairing.expiresAt - now;
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
      <div className="fx-rise-in flex w-full min-w-0 flex-col gap-3">
        <p className="flex items-center gap-1 text-ui text-muted-foreground">
          {deviceScopeLabels(props.scopes)}
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
          <p
            aria-label={`Pairing code ${pairing.code}`}
            className="font-mono text-lg font-semibold tracking-[0.14em] tabular-nums"
          >
            {pairing.code}
          </p>
          <div className="h-[3px] w-44 overflow-hidden rounded-full bg-fill-strong">
            <span
              className="block h-full rounded-full bg-ring transition-[width] duration-1000 ease-linear"
              style={{ width: `${Math.max(0, Math.min(1, left / codeLifeMs)) * 100}%` }}
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
