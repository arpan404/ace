import { fleetRefusal } from "@ace/ui-core";
import {
  allowProjectsOffer,
  scopeChangeRefusal,
  type TransferMachine,
} from "@ace/ui-core/transfers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandStepFooter,
  CommandStepRow,
  commandStepField,
} from "@/components/ui/command-step.tsx";
import { cn } from "@/lib/cn.ts";
import { useMachines, usePrimaryMachine, useScopedMachine } from "@/lib/machines.ts";
import {
  fleetKeys,
  machineDevices,
  refusalCode,
  setDeviceScope,
} from "@/features/settings/index.ts";

/**
 * A machine that doesn't take projects from the sending one (ADR 0101): why in one sentence, and
 * the next step. When this window manages that machine and may grant Projects there, "Allow
 * projects on <machine>" widens the link's own device at once and goes on to the options;
 * otherwise "Open Settings › Fleet" opens that machine's page, where whoever can allows them. A
 * link that may only view there is sent to link again, and a machine whose ace predates the
 * command says to update it.
 */
export function AllowProjectsStep(props: {
  /** "Continue on Old laptop" or "Open on Old laptop". */
  title: string;
  machine: TransferMachine;
  onBack(): void;
  onAllowed(): void;
  onClose(): void;
}) {
  const { machine } = props;
  const own = usePrimaryMachine();
  const sender = useScopedMachine() ?? own;
  const reached = useMachines().find((each) => each.id === machine.hostId && each.client);
  const queries = useQueryClient();
  const navigate = useNavigate();
  const devices = useQuery({
    queryKey: fleetKeys.devices(machine.hostId),
    queryFn: () => (reached?.client ? machineDevices(reached.client) : Promise.resolve([])),
    enabled: reached !== undefined,
    // Not an administrator there: asking again changes nothing.
    retry: (failures: number, error: unknown) => refusalCode(error) !== "forbidden" && failures < 3,
  });
  const offer = allowProjectsOffer({
    reached: reached !== undefined,
    deviceId: machine.deviceId,
    devices: devices.isError ? "refused" : devices.isSuccess ? devices.data : "pending",
  });
  const allow = useMutation({
    mutationFn: async () => {
      if (!reached?.client) throw new Error(`${machine.name} is offline.`);
      await setDeviceScope(reached.client, {
        deviceId: machine.deviceId,
        scope: "projects",
        allowed: true,
        commandId: crypto.randomUUID(),
      });
      await Promise.all([
        queries.invalidateQueries({ queryKey: fleetKeys.links(own.id) }),
        queries.invalidateQueries({ queryKey: fleetKeys.devices(machine.hostId) }),
      ]);
    },
    onSuccess: props.onAllowed,
  });
  const why = `${machine.name} doesn't take projects from ${sender.name} yet`;
  const refused = allow.isError ? refusalCode(allow.error) : undefined;
  const words =
    refused !== undefined
      ? (scopeChangeRefusal(refused, machine.name) ?? fleetRefusal(refused, machine.name))
      : offer === "viewOnly"
        ? `${sender.name}'s link can only view on ${machine.name}, so it can't take projects; unlink and link them again in Settings › Fleet.`
        : offer === "held"
          ? `${machine.name} takes projects from ${sender.name} now.`
          : offer === "settings"
            ? `${why}; allow them on ${machine.name} in Settings › Fleet.`
            : `${why}.`;
  const settings = () => {
    props.onClose();
    void navigate({
      to: "/settings/remote/$machine",
      params: { machine: reached?.id ?? machine.hostId },
      hash: "links",
    });
  };
  return (
    <>
      <CommandStepRow onBack={props.onBack} closeLabel="Close">
        <span className={cn(commandStepField, "flex items-center truncate")}>{props.title}</span>
      </CommandStepRow>
      <p role={allow.isError ? "alert" : "status"} className="px-4 py-3 text-ui text-foreground">
        {words}
      </p>
      <CommandStepFooter>
        {offer === "held" && !allow.isError ? (
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- Enter takes the one next step.
          <Button variant="primary" size="sm" autoFocus onClick={props.onAllowed}>
            Continue
          </Button>
        ) : offer === "settings" || offer === "viewOnly" || allow.isError ? (
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- Enter takes the one next step.
          <Button variant="primary" size="sm" autoFocus onClick={settings}>
            Open Settings › Fleet
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- Enter takes the one next step.
            autoFocus
            disabled={offer === "checking" || allow.isPending}
            onClick={() => allow.mutate()}
          >
            Allow projects on {machine.name}
          </Button>
        )}
      </CommandStepFooter>
    </>
  );
}
