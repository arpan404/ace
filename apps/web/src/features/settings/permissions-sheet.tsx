import type { MachineGrantLevel } from "@ace/protocol";
import { useState } from "react";
import { HairlineList, HairlineRow, RowAction } from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import type { Machine } from "@/lib/machines.ts";
import { fleetProblem } from "./data/fleet.ts";
import { capabilityRows, grantLevels } from "./data/fleet-grants.ts";
import { grantSummary } from "@ace/ui-core/fleet-map";
import { useGrants } from "./data/use-grants.ts";
import type { Fleet } from "./data/use-fleet.ts";

/** Which links a sheet edits: grants on `hosts`, for the machines `peer` names ("all": every). */
export interface GrantScope {
  hosts: readonly Machine[];
  peer: string;
  title: string;
  /** One line saying where the choices land. */
  sub: string;
}

/**
 * What other machines' agents may use: one Off / Read / Read and act choice per capability.
 * Each choice is saved on every link in scope at once; a capability whose links disagree shows
 * no choice pressed until one is picked.
 */
export function PermissionsSheet(props: { fleet: Fleet; scope: GrantScope; onClose(): void }) {
  const { scope } = props;
  const grants = useGrants(props.fleet, scope.hosts, scope.peer);
  const busy = !grants.loaded || grants.change.isPending || grants.fetching;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{scope.title}</DialogTitle>
          <DialogDescription>{scope.sub}</DialogDescription>
        </DialogHeader>
        {grants.targets.length === 0 && (
          <p className="text-ui text-muted-foreground">
            No machine is linked here yet. Link the machines first.
          </p>
        )}
        {grants.closed && (
          <p className="text-xs text-muted-foreground">
            Agents from other machines are off on one of these machines, so these choices wait until
            that's turned on.
          </p>
        )}
        {grants.limited && (
          <p className="text-xs text-muted-foreground">
            One of these machines lets other machines' agents only read, whatever is chosen here.
          </p>
        )}
        {grants.failures.map((failure) => (
          <p key={failure.machine.id} role="alert" className="text-xs text-destructive">
            {failure.machine.name}: {fleetProblem(failure.error)}
          </p>
        ))}
        {grants.targets.length > 0 && (
          <HairlineList>
            {capabilityRows.map((row) => {
              const value = grants.values[row.capability];
              return (
                <div
                  key={row.capability}
                  className="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-ui text-foreground">{row.title}</span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {value === "mixed" ? `Differs between machines. ${row.note}` : row.note}
                    </span>
                    {row.warning && (
                      <span className="text-xs text-status-needs-you">{row.warning}</span>
                    )}
                  </div>
                  <SegmentedControl<MachineGrantLevel | "mixed">
                    size="sm"
                    label={row.title}
                    value={value ?? "mixed"}
                    options={grantLevels}
                    disabled={busy}
                    onValueChange={(level) => {
                      if (level !== "mixed")
                        grants.change.mutate({ capability: row.capability, level });
                    }}
                  />
                </div>
              );
            })}
          </HairlineList>
        )}
        {grants.change.isError && (
          <p role="alert" className="text-xs text-destructive">
            {grants.change.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One row naming what the links in `scope` allow ("Agents, browser and simulators. Not computer
 * use or commands."), and Edit, which opens the sheet for exactly those links.
 */
export function GrantRow(props: { fleet: Fleet; scope: GrantScope; title: string; id?: string }) {
  const [open, setOpen] = useState(false);
  const grants = useGrants(props.fleet, props.scope.hosts, props.scope.peer);
  const sub =
    grants.targets.length === 0
      ? "No machine is linked yet."
      : grants.failures.length > 0
        ? fleetProblem(grants.failures[0]?.error)
        : !grants.loaded
          ? "Reading…"
          : grantSummary(grants.levels);
  return (
    <>
      <HairlineRow
        id={props.id}
        title={props.title}
        sub={sub}
        actions={
          <RowAction
            className="text-foreground"
            aria-label={`Edit ${props.title}`}
            onClick={() => setOpen(true)}
          >
            Edit
          </RowAction>
        }
      />
      {open && (
        <PermissionsSheet fleet={props.fleet} scope={props.scope} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
