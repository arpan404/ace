import { SettingDisclosure, useHashFlash } from "@/components/setting-row.tsx";
import { Navigate, useLocation } from "@tanstack/react-router";
import { Switch } from "@/components/ui/switch.tsx";
import { deviceScopeLabels, deviceAccessOptions } from "./device-scopes.ts";
import type { PairingScope } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import {
  createPairing,
  deviceLifetimes,
  fleetKeys,
  linkLifetimes,
  machineDevices,
  type DeviceLifetime,
  type LinkLifetime,
} from "./data/fleet.ts";
import { useRemoteStatus } from "./data/use-settings.ts";
import { Paired, PairingCode } from "./pairing-code.tsx";

type Access = "operate" | "read" | "admin";
const scopesFor: Record<Access, PairingScope[]> = {
  operate: ["read", "operate"],
  read: ["read"],
  admin: ["read", "operate", "admin"],
};

/** While a code is on screen, the paired list is read this often to catch the new device. */
const watchMs = 2_000;

const accessDescriptions: Record<Access, string> = {
  operate: "Follow threads, answer approvals, send messages and stop agents.",
  read: "Follow threads and read transcripts. Nothing it does changes anything.",
  admin: "Everything, plus settings, pairing, revoking and computer use.",
};

/** Grants apart from the access level, each its own switch. */
const advancedScopes: readonly { value: "projects" | "accounts"; label: string; what: string }[] = [
  { value: "projects", label: "Projects", what: "Add and remove project folders." },
  { value: "accounts", label: "Accounts", what: "Add and remove provider accounts." },
];

const linkOptions = linkLifetimes.map((entry) => ({
  value: String(entry.value),
  label: entry.label,
}));
const deviceOptions = deviceLifetimes.map((entry) => ({
  value: String(entry.value),
  label: entry.label,
}));

/** One access level to pair with: its name and what it allows, chosen as a whole row. */
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
      className="-mx-3 flex w-[calc(100%+1.5rem)] items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset"
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

/** A labelled control in the pairing form, label left and control right. */
function Field(props: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4">
      <span className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={props.htmlFor} className="text-ui text-foreground">
          {props.label}
        </label>
        {props.hint && <span className="text-xs text-muted-foreground">{props.hint}</span>}
      </span>
      {props.children}
    </div>
  );
}

/**
 * Whether `machine` can issue a link a device can use: remote access on over LAN or Tailscale.
 * This window's own machine reports its live listener; another machine refuses a pairing itself
 * with its reason when it can't.
 */
function useReach(machine: Machine | undefined) {
  const remote = useRemoteStatus();
  if (!machine?.primary) return { reachable: true, note: undefined };
  const reachable =
    !remote.isFetching &&
    remote.data?.enabled === true &&
    ["lan", "tailscale"].includes(remote.data.transport);
  const note = remote.isFetching
    ? "Checking remote access…"
    : reachable
      ? `Connect your device to ${remote.data?.transport === "tailscale" ? "your Tailscale network" : "the same local network"} to pair.`
      : remote.isError
        ? "Couldn't check remote access. Reconnect and try again."
        : !remote.data
          ? "Checking remote access…"
          : "Turn on LAN or Tailscale access before pairing.";
  return { reachable, note };
}

/**
 * Pair a phone or browser: which machine, what it may do, what it's called and how long the
 * link and the device's access last. Then a one-time QR code and link; the paired list is
 * watched, and the new device replaces the code with a confirmation.
 */
function PairingFlow({
  ref,
  ...props
}: {
  close(): void;
  machine?: string | undefined;
  ref: Ref<HTMLDivElement>;
}) {
  const id = useId();
  const machines = useMachines().filter((machine) => machine.client);
  const [machineId, setMachineId] = useState(props.machine ?? machines[0]?.id);
  const machine = machines.find((entry) => entry.id === machineId) ?? machines[0];
  const { reachable, note } = useReach(machine);
  const queries = useQueryClient();
  const [access, setAccess] = useState<Access>("operate");
  const [advanced, setAdvanced] = useState<PairingScope[]>([]);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState<LinkLifetime>(linkLifetimes[0].value);
  const [deviceTtl, setDeviceTtl] = useState<DeviceLifetime>(0);
  const granted = [...scopesFor[access], ...advanced];
  const [known, setKnown] = useState<ReadonlySet<string>>();
  const pair = useMutation({
    mutationFn: async () => {
      if (!machine?.client) throw new Error("Connect to a machine first.");
      // The devices paired before this code, so the one it pairs stands out.
      const before = await machineDevices(machine.client);
      setKnown(new Set(before.map((device) => device.id)));
      const issued = await createPairing(machine.client, {
        scopes: granted,
        label,
        ttlMs: ttl,
        deviceTtlMs: deviceTtl,
      });
      await queries.invalidateQueries({ queryKey: fleetKeys.pairings(machine.id) });
      return issued;
    },
  });
  const pairing = pair.data;
  const devices = useQuery({
    queryKey: [...fleetKeys.devices(machine?.id ?? ""), "watch"],
    queryFn: () => (machine?.client ? machineDevices(machine.client) : Promise.resolve([])),
    enabled: pairing !== undefined && machine?.client !== undefined,
    refetchInterval: watchMs,
  });
  const paired = known && devices.data?.find((device) => !known.has(device.id));
  const reset = () => {
    pair.reset();
    setKnown(undefined);
  };
  const summary = [
    machines.length > 1 ? machine?.name : undefined,
    label.trim() || undefined,
    deviceScopeLabels(granted),
    deviceTtl
      ? `for ${deviceLifetimes.find((entry) => entry.value === deviceTtl)?.label}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const lifeLabel = linkLifetimes.find((entry) => entry.value === ttl)?.label ?? "5 minutes";
  return (
    // Focus starts on the flow itself, not on the first option: nothing is outlined until the
    // person presses a key.
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <p className="text-sm text-muted-foreground">
        The link works once and expires after {lifeLabel}. {note}
      </p>
      {paired ? (
        <Paired
          device={paired}
          onDone={() => {
            void queries.invalidateQueries({ queryKey: fleetKeys.devices(machine?.id ?? "") });
            props.close();
          }}
        />
      ) : pairing ? (
        <PairingCode
          pairing={pairing}
          lifeMs={ttl}
          summary={summary}
          onChange={reset}
          onRenew={() => pair.mutate()}
          onClose={() => props.close()}
        />
      ) : (
        <>
          {machines.length > 1 && machine && (
            <Field label="Pairs with">
              <Select
                label="Pairs with"
                value={machine.id}
                options={machines.map((entry) => ({ value: entry.id, label: entry.name }))}
                onValueChange={setMachineId}
              />
            </Field>
          )}
          <Field
            label="Device name"
            htmlFor={`${id}-label`}
            hint="Optional. Shown instead of the name the device gives."
          >
            <Input
              id={`${id}-label`}
              value={label}
              maxLength={64}
              placeholder="Living room iPad"
              onChange={(event) => setLabel(event.target.value)}
              className="w-48"
            />
          </Field>
          <div role="radiogroup" aria-label="Access" className="flex flex-col">
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
          {access === "admin" && (
            <p role="note" className="text-xs text-muted-foreground">
              An administrator device can pair and revoke other devices and change every setting.
              Give it only to devices you own.
            </p>
          )}
          <Field label="Link works for">
            <Select
              label="Link works for"
              value={String(ttl)}
              options={linkOptions}
              onValueChange={(value) =>
                setTtl(linkLifetimes.find((entry) => String(entry.value) === value)?.value ?? ttl)
              }
            />
          </Field>
          <Field label="Device keeps access">
            <Select
              label="Device keeps access"
              value={String(deviceTtl)}
              options={deviceOptions}
              onValueChange={(value) =>
                setDeviceTtl(
                  deviceLifetimes.find((entry) => String(entry.value) === value)?.value ?? 0,
                )
              }
            />
          </Field>
          <SettingDisclosure title="Advanced access">
            <div className="flex flex-col">
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
              disabled={pair.isPending || !reachable || !machine}
              onClick={() => pair.mutate()}
            >
              Create link
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  );
}

/** Fleet's Pair a device action opens the same flow as /pair; `machine` picks it to start with. */
export function PairDevice(props: { machine?: string }) {
  // `/pair` lands here with #pair: the dialog opens over the page it belongs to.
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(hash === "pair");
  const flow = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Settings search lands on `#remote.pair`: the button flashes like a row would.
  const flashing = useHashFlash("remote.pair", trigger);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        ref={trigger}
        id="remote.pair"
        data-flash={flashing || undefined}
        size="sm"
        variant="ghost"
        className={cn(flashing && "bg-accent")}
        onClick={() => setOpen(true)}
      >
        Pair a device
      </Button>
      <DialogContent initialFocus={flow}>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
        </DialogHeader>
        {open && <PairingFlow ref={flow} machine={props.machine} close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** `/pair`: the pairing dialog, over Fleet where pairing lives. */
export function PairDevicePage() {
  return <Navigate to="/settings/remote" hash="pair" replace />;
}
