import { Link } from "@tanstack/react-router";
import { HairlineRow, RowGroup, rowLinkClass } from "@/components/hairline-row.tsx";
import { part } from "@/lib/suit-part.ts";
import { useFleet } from "./data/use-fleet.ts";
import { FleetBack } from "./fleet-back.tsx";
import { WorkingAcrossMachines } from "./fleet-working.tsx";
import { SettingsBody } from "./settings-body.tsx";

/** Fleet's one row for how the machines work together; it opens the page that sets it. */
export function AcrossMachinesRow() {
  return (
    <RowGroup label="Across machines">
      <HairlineRow
        data-row="fleet-across"
        link={
          <Link
            to="/settings/remote/every-machine"
            {...part("link", undefined, "row")}
            className={rowLinkClass}
          >
            Same for every machine
          </Link>
        }
        title="Same for every machine"
        sub="Other machines' agents, what they may use, and moving threads"
      />
    </RowGroup>
  );
}

/**
 * Settings › Fleet › Same for every machine: how the machines work together, set on every
 * connected machine at once. A machine's own page sets it there alone.
 */
export function FleetAcrossPage() {
  const fleet = useFleet();
  return (
    <SettingsBody page="Same for every machine" back={<FleetBack />}>
      <WorkingAcrossMachines fleet={fleet} />
    </SettingsBody>
  );
}
