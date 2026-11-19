import { Link } from "@tanstack/react-router";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { useMachines, usePrimaryMachine } from "@/lib/machines.ts";
import { MachineAccount } from "../machine-account.tsx";
import { settingRow } from "../settings-index.ts";
import { SettingsBody } from "../settings-body.tsx";
import { PersonSection, useProfileAccount } from "./account.tsx";
import { ActivitySection, InsightsSection, ProvidersSection } from "./activity.tsx";
import { Legal, NameSetting } from "./you.tsx";
import { useProfileActivity } from "./use-stats.ts";

/**
 * Profile, a settings page like the others: the person and their ace account, a year of their
 * agents' work on this computer (the headline numbers, a day-by-day grid, the providers they
 * lean on and a few insights), then this computer's place on the account and the name ace shows
 * beside their messages.
 */
export function ProfilePage() {
  const account = useProfileAccount();
  const activity = useProfileActivity();
  return (
    <SettingsBody page="Profile">
      <PersonSection account={account} />
      <ActivitySection activity={activity} />
      <ProvidersSection shares={activity.providers} />
      <InsightsSection activity={activity} />
      {account.session && <AccountMachines />}
      <NameSetting />
      <Legal />
    </SettingsBody>
  );
}

/** "3 machines", "1 machine". */
const machineCount = (count: number) => (count === 1 ? "1 machine" : `${count} machines`);

function AccountMachines() {
  const primary = usePrimaryMachine();
  const machines = useMachines();
  const account = useAccountMachines(machines);
  const names = [
    ...machines.filter((machine) => account.alsoOnAccount.has(machine.id)).map((m) => m.name),
    ...account.only.map((machine) => machine.name),
  ];
  return (
    <>
      <MachineAccount machine={primary} label="This computer" />
      <SettingSection label="Machines on your account" card>
        <SettingRow
          {...settingRow("profile.machines")}
          title={names.length ? machineCount(names.length) : "No machines yet"}
          description={
            names.length
              ? names.join(", ")
              : "Sign a computer in to your account to open it from your other devices."
          }
          inline
        >
          <Button size="sm" variant="ghost" render={<Link to="/settings/remote" />}>
            Open Fleet
          </Button>
        </SettingRow>
        {account.error && (
          <SettingNote role="alert">
            Couldn't load your account's machines. Try again later.
          </SettingNote>
        )}
      </SettingSection>
    </>
  );
}
