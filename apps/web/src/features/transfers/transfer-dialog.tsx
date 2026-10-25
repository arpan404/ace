import { transferRunning } from "@ace/client";
import {
  useClient,
  useProjectTransfer,
  useThreadTransfer,
  useTransfers,
  useTransfersSeeded,
} from "@ace/client-react";
import { DesktopIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { CommandChoices, type CommandChoice } from "@/components/ui/command-choices.tsx";
import { CommandDialog } from "@/components/ui/command.tsx";
import {
  CommandStepFooter,
  CommandStepRow,
  commandStepField,
} from "@/components/ui/command-step.tsx";
import { listDivider } from "@/components/ui/rules.ts";
import { Switch } from "@/components/ui/switch.tsx";
import type { Transfer } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { useMachines, usePrimaryMachine, type Machine } from "@/lib/machines.ts";
import type { TransferRequest } from "@/lib/transfer-opener.ts";
import { fleetKeys, machineLinks, settingKeys, useSetting } from "@/features/settings/index.ts";
import { FolderChoice } from "./folder-choice.tsx";
import { TransferLine } from "./transfer-line.tsx";
import { transferMachines, type TransferMachine } from "./transfer-machines.ts";
import { useTransferLine } from "./transfer-status.ts";
import { refusalWords } from "./transfer-words.ts";
import {
  placementOf,
  useTransferActions,
  type Placement,
  type Refusal,
} from "./use-transfer-actions.ts";

type Step =
  /** Until this machine's transfer list has answered: one may already be running. */
  | { kind: "checking" }
  | { kind: "machines" }
  | { kind: "options"; machine: TransferMachine }
  | {
      kind: "status";
      machine: { hostId: string; name: string };
      placement: Placement | undefined;
      /** The command's id once the daemon took it, or why it refused. */
      started: { commandId: string } | { refused: Refusal } | undefined;
    };

const verb = (request: TransferRequest) => (request.kind === "thread" ? "Continue" : "Open");

/**
 * "Continue on…" and "Open on…" (ADR 0101): which machine, then where and whether to bring
 * uncommitted changes and ignored files, then the transfer's one line until it's done. Machines
 * this one has fleet links to are listed; offline or not-allowed ones show why, and none links to
 * Settings › Fleet. A transfer already running for this thread or project opens on its line, so
 * the machines wait until this machine's transfer list has answered. A request naming its
 * machine (Try again) opens on that machine's options.
 */
export function TransferDialog(props: {
  request: TransferRequest;
  open: boolean;
  onClose(): void;
}) {
  const { request } = props;
  const thread = useThreadTransfer(request.kind === "thread" ? request.threadId : undefined);
  const project = useProjectTransfer(request.kind === "project" ? request.workspaceId : undefined);
  const latest = request.kind === "thread" ? thread : project;
  const seeded = useTransfersSeeded();
  const [step, setStep] = useState<Step>(() =>
    request.machine
      ? { kind: "options", machine: request.machine }
      : seeded
        ? opening(latest)
        : { kind: "checking" },
  );
  // Decided when the list answers, so a transfer that settles meanwhile keeps its line. One that
  // turns up running while the machines show (a reconnect's list, or another window's push)
  // takes their place: a second transfer must not be offered.
  if (seeded && step.kind === "checking") setStep(opening(latest));
  else if (step.kind === "machines" && latest && transferRunning(latest)) setStep(opening(latest));
  const { start } = useTransferActions();
  // This machine's "Bring ignored files", read here so the options step never waits for it.
  const [ignoredByDefault] = useSetting(settingKeys.transferIgnoredFiles);
  const send = (machine: { hostId: string; name: string }, placement: Placement) => {
    setStep({ kind: "status", machine, placement, started: undefined });
    void start(request, placement).then((started) =>
      setStep((current) =>
        current.kind === "status" && current.placement === placement
          ? {
              ...current,
              started: started.ok ? { commandId: started.commandId } : { refused: started },
            }
          : current,
      ),
    );
  };
  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={`${verb(request)} on another machine`}
    >
      {step.kind === "checking" ? (
        <CommandStepRow onBack={undefined} closeLabel="Close">
          <span
            className={cn(commandStepField, "flex items-center truncate text-muted-foreground")}
          >
            Checking what this machine is sending…
          </span>
        </CommandStepRow>
      ) : step.kind === "machines" ? (
        <MachineStep
          request={request}
          onChoose={(machine) => setStep({ kind: "options", machine })}
          onClose={props.onClose}
        />
      ) : step.kind === "options" ? (
        <OptionsStep
          request={request}
          machine={step.machine}
          ignoredByDefault={ignoredByDefault}
          onBack={() => setStep({ kind: "machines" })}
          onSend={(placement) => send(step.machine, placement)}
        />
      ) : (
        <StatusStep
          request={request}
          step={step}
          onClose={props.onClose}
          onRetry={(echoed) => {
            // The choices made here, else the ones the transfer's record echoes, else ask again.
            const placement = step.placement ?? echoed;
            if (placement) send(step.machine, placement);
            else setStep({ kind: "options", machine: step.machine });
          }}
        />
      )}
    </CommandDialog>
  );
}

/** The first step: a running transfer's line, else the machines. */
function opening(latest: Transfer | undefined): Step {
  return latest && transferRunning(latest)
    ? {
        kind: "status",
        machine: latest.target,
        placement: undefined,
        started: { commandId: latest.commandId },
      }
    : { kind: "machines" };
}

function MachineStep(props: {
  request: TransferRequest;
  onChoose(machine: TransferMachine): void;
  onClose(): void;
}) {
  const client = useClient();
  const own = usePrimaryMachine();
  const links = useQuery({
    queryKey: fleetKeys.links(own.id),
    queryFn: () => machineLinks(client),
  });
  const machines = useMemo(() => transferMachines(links.data ?? []), [links.data]);
  const choices = useMemo(
    () =>
      machines.map((machine): CommandChoice => ({
        id: machine.hostId,
        label: machine.name,
        icon: DesktopIcon,
        ...(machine.reason
          ? {
              disabled: true,
              aside: <span className="text-xs text-muted-foreground">{machine.reason}</span>,
            }
          : {}),
      })),
    [machines],
  );
  const what = props.request.kind === "thread" ? `“${props.request.title}”` : props.request.name;
  const empty = links.isPending ? (
    "Looking for linked machines…"
  ) : links.isError ? (
    "Couldn't read this machine's links. Try again in a moment."
  ) : machines.length ? (
    "No machines match"
  ) : (
    <>
      No other machines are linked to this one.{" "}
      <Link to="/settings/remote" className="text-link" onClick={props.onClose}>
        Settings › Fleet
      </Link>
    </>
  );
  return (
    <CommandChoices
      fieldLabel="Search machines"
      listLabel="Machines"
      placeholder={`${verb(props.request)} ${what} on…`}
      choices={choices}
      onChoose={(choice) => {
        const machine = machines.find((each) => each.hostId === choice.id);
        if (machine) props.onChoose(machine);
      }}
      onBack={undefined}
      empty={empty}
    />
  );
}

function OptionsStep(props: {
  request: TransferRequest;
  machine: TransferMachine;
  ignoredByDefault: boolean;
  onBack(): void;
  onSend(placement: Placement): void;
}) {
  const id = useId();
  const reached: Machine | undefined = useMachines().find(
    (each) => each.id === props.machine.hostId && each.client,
  );
  const [parent, setParent] = useState<string>();
  const [changes, setChanges] = useState(true);
  // Follows this machine's "Bring ignored files" until the person flips it here.
  const [ignoredChoice, setIgnored] = useState<boolean>();
  const ignored = ignoredChoice ?? props.ignoredByDefault;
  const action = `${verb(props.request)} on ${props.machine.name}`;
  const send = () =>
    props.onSend({
      hostId: props.machine.hostId,
      parent,
      includeChanges: changes,
      includeIgnored: ignored,
    });
  return (
    <>
      <CommandStepRow onBack={props.onBack} closeLabel="Close">
        <span className={cn(commandStepField, "flex items-center truncate")}>{action}</span>
      </CommandStepRow>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-1 text-ui", listDivider)}>
        <div className="flex h-11 items-center gap-3">
          <label htmlFor={`${id}-changes`} className="min-w-0 flex-1 truncate text-foreground">
            Bring uncommitted changes
          </label>
          <Switch id={`${id}-changes`} checked={changes} onCheckedChange={setChanges} />
        </div>
        <div className="flex h-11 items-center gap-3">
          <label htmlFor={`${id}-ignored`} className="min-w-0 flex-1 truncate text-foreground">
            Bring ignored files
          </label>
          <Switch id={`${id}-ignored`} checked={ignored} onCheckedChange={setIgnored} />
        </div>
        <FolderChoice machine={reached} name={props.machine.name} onParent={setParent} />
      </div>
      <CommandStepFooter>
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- Enter sends from the step. */}
        <Button variant="primary" size="sm" autoFocus onClick={send}>
          {action}
        </Button>
      </CommandStepFooter>
    </>
  );
}

function StatusStep(props: {
  request: TransferRequest;
  step: Extract<Step, { kind: "status" }>;
  onRetry(echoed?: Placement): void;
  onClose(): void;
}) {
  const { step } = props;
  const transfers = useTransfers();
  const started = step.started;
  const transfer =
    started && "commandId" in started
      ? transfers.find((each) => each.commandId === started.commandId)
      : undefined;
  return (
    <>
      <CommandStepRow
        onBack={undefined}
        closeLabel="Close"
        leading={<DesktopIcon aria-hidden size={18} className="shrink-0 text-muted-foreground" />}
      >
        <span className={cn(commandStepField, "flex items-center truncate")}>
          {verb(props.request)} on {step.machine.name}
        </span>
      </CommandStepRow>
      <div className="px-3 py-3">
        {transfer ? (
          <KnownTransfer transfer={transfer} onRetry={props.onRetry} onOpen={props.onClose} />
        ) : started && "refused" in started ? (
          <TransferLine
            alert
            words={refusalWords(started.refused, step.machine.name)}
            actions={[{ label: "Try again", run: () => props.onRetry() }]}
          />
        ) : (
          <TransferLine words={`Getting ready to send to ${step.machine.name}`} actions={[]} />
        )}
      </div>
    </>
  );
}

function KnownTransfer(props: {
  transfer: Transfer;
  onRetry(echoed: Placement | undefined): void;
  onOpen(): void;
}) {
  const line = useTransferLine(
    props.transfer,
    () => props.onRetry(placementOf(props.transfer)),
    props.onOpen,
  );
  return <TransferLine {...line} />;
}
