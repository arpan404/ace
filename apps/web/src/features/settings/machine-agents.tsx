import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowAction, RowGroup } from "@/components/hairline-row.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { MachineScope } from "@/lib/machine-scope.tsx";
import type { Machine } from "@/lib/machines.ts";
import { fleetProblem } from "./data/fleet.ts";
import { reach, unlinkedWith } from "./data/fleet-links.ts";
import { listNames } from "@ace/ui-core";
import type { Fleet } from "./data/use-fleet.ts";
import { AgentAccessRow, TransfersRow } from "./fleet-working.tsx";
import { GrantRow } from "./permissions-sheet.tsx";

/**
 * A machine's agents, both ways: how far other machines' agents may go on it, what each
 * direction may use (each Edit opens the sheet for this machine's links alone), whether its
 * agents move threads, and its links with the other machines.
 */
export function MachineAgents(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const others = fleet.machines.filter((entry) => entry.id !== machine.id);
  const connected = others.filter((entry) => entry.client);
  if (others.length === 0) return null;
  return (
    <RowGroup label="Agents" anchor="links">
      {machine.client ? (
        <MachineScope machine={machine}>
          <AgentAccessRow />
        </MachineScope>
      ) : (
        <HairlineRow title="Other machines' agents" sub="Shows when it's back online." />
      )}
      <GrantRow
        fleet={fleet}
        title={`${machine.name}'s agents on your other machines`}
        scope={{
          hosts: connected,
          peer: machine.id,
          title: `What ${machine.name}'s agents may use`,
          sub: `On your other machines, for ${machine.name} only.`,
        }}
      />
      <GrantRow
        fleet={fleet}
        title={`Your other machines' agents on ${machine.name}`}
        scope={{
          hosts: [machine],
          peer: "all",
          title: `What other machines' agents may use on ${machine.name}`,
          sub: `On ${machine.name}, for every machine linked to it.`,
        }}
      />
      {machine.client && (
        <MachineScope machine={machine}>
          <TransfersRow />
        </MachineScope>
      )}
      <LinksRow machine={machine} fleet={fleet} others={others} />
    </RowGroup>
  );
}

/** Whether a direction holds a link at all, whatever its state. */
const held = (kind: string) => kind !== "missing" && kind !== "unknown";

/** Whether this machine and the others hold links both ways; Link fills the gaps, Unlink ends them. */
function LinksRow(props: { machine: Machine; fleet: Fleet; others: readonly Machine[] }) {
  const { machine, fleet } = props;
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const self = fleet.facts.find((entry) => entry.id === machine.id);
  const missing = unlinkedWith(machine.id, fleet.gaps);
  const gaps = fleet.gaps.filter((gap) => gap.from === machine.id || gap.to === machine.id);
  const linked = props.others.filter((other) => {
    const facts = fleet.facts.find((entry) => entry.id === other.id);
    return (
      self !== undefined &&
      facts !== undefined &&
      (held(reach(self, facts).kind) || held(reach(facts, self).kind))
    );
  });
  const name = (id: string) => fleet.byId(id)?.name ?? "a machine";
  const error = fleet.links.get(machine.id)?.error;
  const sub = error
    ? fleetProblem(error)
    : [
        linked.length ? `Linked with ${listNames(linked.map((entry) => entry.name))}.` : undefined,
        missing.length ? `Not fully linked with ${listNames(missing.map(name))} yet.` : undefined,
      ]
        .filter(Boolean)
        .join(" ") || "Not linked with your other machines.";
  return (
    <>
      <HairlineRow
        title="Links"
        sub={sub}
        actions={
          <>
            {linked.length > 0 && (
              <RowAction
                reveal
                tone="danger"
                disabled={fleet.unlink.isPending}
                onClick={() =>
                  setConfirming({
                    title: `Unlink ${machine.name}?`,
                    body: `Agents on ${machine.name} stop using ${listNames(linked.map((entry) => entry.name))}, and theirs stop using it. Link them again any time.`,
                    confirm: "Unlink",
                    run: () =>
                      fleet.unlink.mutate(
                        { machine, others: linked },
                        {
                          onError: (failure) =>
                            toast.error({ title: "Couldn't unlink", description: failure.message }),
                        },
                      ),
                  })
                }
              >
                Unlink
              </RowAction>
            )}
            {gaps.length > 0 && (
              <RowAction
                className="text-foreground"
                disabled={fleet.link.isPending}
                onClick={() =>
                  fleet.link.mutate(gaps, {
                    onError: (failure) =>
                      toast.error({ title: "Couldn't link", description: failure.message }),
                  })
                }
              >
                Link
              </RowAction>
            )}
          </>
        }
      />
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}
