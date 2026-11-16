import { ViewSidebar } from "@/features/shell/index.ts";
import { NoMachineFleetPage } from "./no-machine-fleet.tsx";
import { NoMachineProfilePage } from "./profile/no-machine-page.tsx";
import { SettingsBody } from "./settings-body.tsx";
import { SettingsPageLinks } from "./settings-nav.tsx";
import { settingsPages, type SettingsPath } from "./settings-pages.ts";

/** With no machine only Profile and Fleet have anything to show. */
const paths = new Set<SettingsPath>(["/settings/profile", "/settings/remote"]);
const pages = settingsPages.filter((page) => paths.has(page.to));

/** Settings' list in the sidebar of a window with no machine. */
export function NoMachineSettingsNav() {
  return (
    <ViewSidebar title="Settings">
      <nav aria-label="Settings pages">
        <SettingsPageLinks pages={pages} />
      </nav>
    </ViewSidebar>
  );
}

export function NoMachineProfileScreen() {
  return <NoMachineProfilePage />;
}

/** Fleet with no machine; `pairing` opens on the pairing form (the `/pair` address). */
export function NoMachineFleetScreen(props: { pairing?: boolean | undefined }) {
  return (
    <SettingsBody
      page="Fleet"
      lede="This window isn't connected to a machine. Open one on your ace account, or add one below."
    >
      <NoMachineFleetPage pairing={props.pairing} />
    </SettingsBody>
  );
}
