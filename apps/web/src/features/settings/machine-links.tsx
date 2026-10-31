import { useState } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import type { Machine } from "@/lib/machines.ts";
import { fleetProblem } from "./data/fleet.ts";
import { reach, type Reach } from "./data/fleet-links.ts";
import type { Fleet } from "./data/use-fleet.ts";
import { LinkedMachineAccess } from "./fleet-capabilities.tsx";

function reachLabel(value: Reach): string {
  switch (value.kind) {
    case "linked":
      return value.access === "operate" ? "Read and act" : "Read only";
    case "closed":
      return "Agents off there";
    case "unreachable":
      return "Couldn't reach";
    case "missing":
      return "Not linked";
    case "unknown":
      return "Unknown";
  }
}

function summarizeReach(values: readonly Reach[]): string {
  if (values.length === 1 && values[0]) return reachLabel(values[0]);
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = reachLabel(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label}: ${count}`).join(" · ");
}

/** One selector controls both link directions and the permission editor below. */
export function MachineLinks(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const [selection, setSelected] = useState("all");
  const self = fleet.facts.find((entry) => entry.id === machine.id);
  const others = fleet.facts.filter((entry) => entry.id !== machine.id);
  const selected =
    selection === "all" || others.some((entry) => entry.id === selection) ? selection : "all";
  const peers = selected === "all" ? others : others.filter((entry) => entry.id === selected);
  const peerIds = new Set(peers.map((peer) => peer.id));
  const gaps = fleet.gaps.filter(
    (gap) =>
      (gap.from === machine.id && peerIds.has(gap.to)) ||
      (gap.to === machine.id && peerIds.has(gap.from)),
  );
  const targets = peers.flatMap((peer) => {
    const entry = fleet.byId(peer.id);
    return entry ? [entry] : [];
  });
  const linksError = fleet.links.get(machine.id)?.error;
  if (!self) return null;
  return (
    <>
      <SettingSection
        label="Links"
        anchor="links"
        note="Select one machine or all machines. The selection also applies to the permissions below."
      >
        <SettingRow title="Manage connections">
          <Select
            label="Machines to configure"
            value={selected}
            options={[
              { value: "all", label: "All linked machines" },
              ...others.map((other) => ({ value: other.id, label: other.name })),
            ]}
            onValueChange={setSelected}
            disabled={fleet.link.isPending || fleet.unlink.isPending}
          />
          {gaps.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={fleet.link.isPending}
              onClick={() =>
                fleet.link.mutate(gaps, {
                  onError: (error) =>
                    toast.error({ title: "Couldn't link", description: error.message }),
                })
              }
            >
              {selected === "all" ? "Link all" : "Link"}
            </Button>
          )}
          {selected !== "all" && gaps.length === 0 && targets.length > 0 && (
            <RowMenu label={`Actions for ${targets[0]?.name}`}>
              <MenuItem
                danger
                onClick={() =>
                  setConfirming({
                    title: `Unlink ${machine.name} and ${targets[0]?.name}?`,
                    body: "Agents on either machine stop using the other. Link them again any time.",
                    confirm: "Unlink",
                    run: () =>
                      fleet.unlink.mutate(
                        { machine, others: targets },
                        {
                          onError: (error) =>
                            toast.error({ title: "Couldn't unlink", description: error.message }),
                        },
                      ),
                  })
                }
              >
                Unlink
              </MenuItem>
            </RowMenu>
          )}
        </SettingRow>
        {others.length === 0 && (
          <SettingNote>Add another machine to link it with this one.</SettingNote>
        )}
        {linksError && <SettingNote role="alert">{fleetProblem(linksError)}</SettingNote>}
        {peers.length > 0 && (
          <>
            <SettingRow
              title={`${machine.name} → selected machines`}
              description="What this machine's agents can do on the selection."
            >
              <span className="text-ui text-muted-foreground">
                {summarizeReach(peers.map((peer) => reach(self, peer)))}
              </span>
            </SettingRow>
            <SettingRow
              title={`Selected machines → ${machine.name}`}
              description="What their agents can do here, subject to the permissions below."
            >
              <span className="text-ui text-muted-foreground">
                {summarizeReach(peers.map((peer) => reach(peer, self)))}
              </span>
            </SettingRow>
          </>
        )}
        <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
      </SettingSection>
      <LinkedMachineAccess machine={machine} fleet={fleet} peer={selected} />
    </>
  );
}
