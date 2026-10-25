import { Outlet, useLocation } from "@tanstack/react-router";
import { AllMachinesScope } from "./all-machines-scope.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { machineUnavailableText, useSettingsMachine } from "./machine-scope.tsx";
import { SettingsBody } from "./settings-body.tsx";
import { settingsPageOf, type SettingsPath } from "./settings-pages.ts";

/**
 * The open Settings page. A Machine page renders whole against the machine picked in the
 * sidebar (every read and write goes there); while that machine is offline or gone, the page
 * keeps its title and says so. Other pages render as they are.
 */
export function SettingsOutlet() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const page = settingsPageOf(pathname);
  const { machine, machines, missing, choose, all } = useSettingsMachine();
  if (page?.group !== "machine") return <Outlet />;
  if (all) {
    if (!supportsAllMachines(page.to))
      return (
        <SettingsBody page={page.title}>
          <EmptyState
            className="mt-10 h-auto"
            title={`${page.title} belong to one machine`}
            description="Pick a machine under the title to see them."
          />
        </SettingsBody>
      );
    return (
      <AllMachinesScope machines={machines}>
        <Outlet />
      </AllMachinesScope>
    );
  }
  if (!machine || missing)
    return (
      <SettingsBody page={page.title}>
        <EmptyState
          className="mt-10 h-auto"
          title="This machine is no longer paired"
          description="Pick another machine in the Settings sidebar."
          action={
            <Button size="sm" variant="secondary" onClick={() => choose(undefined)}>
              Show this machine
            </Button>
          }
        />
      </SettingsBody>
    );
  return (
    <MachineScope
      // Another machine starts the page fresh: no half-typed field carries over. This window's
      // own machine keeps one key while its host id loads, so the page isn't torn down.
      key={machine.primary ? "primary" : machine.id}
      machine={machine}
      unavailable={
        <SettingsBody page={page.title}>
          <EmptyState
            className="mt-10 h-auto"
            title={`${machine.name} is offline`}
            description={machineUnavailableText(machine)}
          />
        </SettingsBody>
      }
    >
      <Outlet />
    </MachineScope>
  );
}

/** Pages whose settings mean the same on every machine, so "All machines" can set them at once. */
function supportsAllMachines(page: SettingsPath): boolean {
  return page === "/settings/agents" || page === "/settings/browser";
}
