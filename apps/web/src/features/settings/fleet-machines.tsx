import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import {
  HairlineRow,
  RowAction,
  RowGroup,
  RowTile,
  StateWords,
  rowLinkClass,
} from "@/components/hairline-row.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  AccountMachineRow,
  type AccountMachine,
  useAccountMachines,
} from "@/features/ace-account/index.ts";
import { primaryMachineId, type Machine } from "@/lib/machines.ts";
import { fleetProblem } from "./data/fleet.ts";
import { machineGaps, reach, unlinkedWith, type LinkGap } from "./data/fleet-links.ts";
import { summarizeNames } from "./data/list-names.ts";
import { machineState, pathWordsFor } from "./data/fleet-words.ts";
import type { Fleet } from "./data/use-fleet.ts";
import { UpdateRowAction, UpdateWords } from "./fleet-software.tsx";
import { MachineDirectory } from "./machine-directory.tsx";

type Row =
  | { id: string; name: string; machine: Machine; account?: undefined }
  | { id: string; name: string; account: AccountMachine; machine?: undefined };

/**
 * Every machine once: this window's, the paired ones, then those only on the ace account. Each
 * row opens the machine's page (an account machine opens through ace's relay instead). A machine
 * missing a link offers Link; a machine just added links with the rest on its own.
 */
export function FleetMachines(props: {
  fleet: Fleet;
  account: ReturnType<typeof useAccountMachines>;
  /** Under this computer's name: how it's reached. */
  ownLine: string;
  /** The machine just added, to link with the rest once its links can be read. */
  added: string | undefined;
}) {
  const { fleet, account } = props;
  const toast = useToast();
  const rows = useMemo<Row[]>(
    () => [
      ...fleet.machines.map((machine) => ({ id: machine.id, name: machine.name, machine })),
      ...account.only.map((entry) => ({ id: entry.hostId, name: entry.name, account: entry })),
    ],
    [fleet.machines, account.only],
  );
  const linkAll = (gaps: readonly LinkGap[]) =>
    fleet.link.mutate(gaps, {
      onSuccess: () => toast.add({ title: "Machines linked" }),
      onError: (error) =>
        toast.error({ title: "Some machines didn't link", description: error.message }),
    });
  useAutoLink(fleet, props.added, linkAll);
  return (
    <RowGroup
      label="Machines"
      count={rows.length}
      anchor="fleet.link"
      actions={
        fleet.gaps.length > 0 && (
          <RowAction
            className="text-foreground"
            disabled={fleet.link.isPending}
            onClick={() => linkAll(fleet.gaps)}
          >
            {fleet.link.isPending ? "Linking…" : "Link all machines"}
          </RowAction>
        )
      }
    >
      <MachineDirectory machines={rows} label="Search fleet machines">
        {(shown) =>
          shown.map((row) =>
            row.account ? (
              <AccountMachineRow
                key={row.id}
                machine={row.account}
                onForget={(hostId) => account.forget.mutateAsync(hostId)}
              />
            ) : (
              <MachineRow
                key={row.id}
                machine={row.machine}
                fleet={fleet}
                ownLine={props.ownLine}
                onAccount={account.alsoOnAccount.has(row.id)}
                onLink={linkAll}
              />
            ),
          )
        }
      </MachineDirectory>
      {account.error && (
        <p role="alert" className="py-2.5 text-xs text-muted-foreground">
          Couldn't list the machines on your ace account. Try again later.
        </p>
      )}
    </RowGroup>
  );
}

/** A machine just added links with every other one as soon as its links can be read. */
function useAutoLink(
  fleet: Fleet,
  added: string | undefined,
  linkAll: (gaps: readonly LinkGap[]) => void,
) {
  const handled = useRef<string>(undefined);
  const ready = added !== undefined && fleet.links.get(added)?.isSuccess === true;
  useEffect(() => {
    if (!ready || !added || handled.current === added || fleet.link.isPending) return;
    handled.current = added;
    const gaps = fleet.gaps.filter((gap) => gap.from === added || gap.to === added);
    if (gaps.length) linkAll(gaps);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once the new machine is readable
  }, [ready]);
}

/** What a paired machine's row says: its state, then what's in the way of its links. */
function statusLine(machine: Machine, fleet: Fleet, onAccount: boolean) {
  const state = machineState(machine.status, !!machine.failed);
  const links = fleet.links.get(machine.id);
  const self = fleet.facts.find((entry) => entry.id === machine.id);
  const closed =
    machine.status === "online" &&
    self !== undefined &&
    fleet.facts.some((other) => other.id !== machine.id && reach(other, self).kind === "closed");
  const extra = [
    machine.status === "online" ? pathWordsFor(machine.path) : undefined,
    onAccount ? "ace account" : undefined,
    machine.status === "online" && links?.isError ? fleetProblem(links.error) : undefined,
    closed ? "other machines' agents are off there" : undefined,
  ].filter(Boolean);
  return (
    <>
      <StateWords tone={state.tone}>{state.words}</StateWords>
      {extra.length > 0 && ` · ${extra.join(" · ")}`}
    </>
  );
}

/**
 * What a machine is missing, per direction: "Not linked with A" when neither holds a link, and
 * which side can't use the other when only one does.
 */
function gapLine(machine: string, fleet: Fleet): string {
  const names = (ids: readonly string[]) =>
    summarizeNames(ids.map((id) => fleet.byId(id)?.name ?? "a machine"));
  const gaps = machineGaps(machine, fleet.gaps);
  return [
    gaps.unlinked.length ? `Not linked with ${names(gaps.unlinked)}` : undefined,
    gaps.cantUse.length ? `Can't use ${names(gaps.cantUse)}` : undefined,
    gaps.notUsedBy.length ? `${names(gaps.notUsedBy)} can't use it` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function MachineRow(props: {
  machine: Machine;
  fleet: Fleet;
  ownLine: string;
  onAccount: boolean;
  onLink(gaps: readonly LinkGap[]): void;
}) {
  const { machine, fleet } = props;
  const missing = unlinkedWith(machine.id, fleet.gaps);
  const gaps = fleet.gaps.filter((gap) => gap.from === machine.id || gap.to === machine.id);
  const online = fleet.machines.filter((entry) => entry.client).length;
  const known = fleet.links.get(machine.id)?.isSuccess;
  const update = fleet.update.line(machine.id);
  return (
    <HairlineRow
      id={machine.primary ? "host.displayName" : undefined}
      data-row="fleet-machine"
      link={
        <Link
          to="/settings/remote/$machine"
          params={{ machine: machine.primary ? primaryMachineId : machine.id }}
          className={rowLinkClass}
        >
          {machine.name}
        </Link>
      }
      tile={
        <RowTile>
          <MachineMark icon={machine.icon} primary={machine.primary} size={15} />
        </RowTile>
      }
      title={machine.name}
      tag={machine.primary ? "this computer" : undefined}
      sub={
        <>
          {machine.primary ? props.ownLine : statusLine(machine, fleet, props.onAccount)}
          {missing.length > 0 && <span className="block">{gapLine(machine.id, fleet)}</span>}
          {update && <UpdateWords line={update} />}
        </>
      }
      meta={missing.length === 0 && known && online > 1 && !machine.primary ? "Linked" : undefined}
      actions={
        (missing.length > 0 || update?.action) && (
          <>
            {update && (
              <UpdateRowAction fleet={fleet} id={machine.id} name={machine.name} line={update} />
            )}
            {missing.length > 0 && (
              <RowAction
                className="text-foreground"
                aria-label={`Link ${machine.name}`}
                disabled={fleet.link.isPending}
                onClick={() => props.onLink(gaps)}
              >
                Link
              </RowAction>
            )}
          </>
        )
      }
    />
  );
}
