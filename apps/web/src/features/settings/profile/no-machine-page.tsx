import { Link } from "@tanstack/react-router";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { settingRow } from "../settings-index.ts";
import { SettingsBody } from "../settings-body.tsx";
import { PersonSection, useProfileAccount } from "./account.tsx";
import { Legal, NameSetting } from "./you.tsx";

const none: readonly { id: string }[] = [];

/**
 * Profile in a window with no machine: the person and their ace account (sign in, sign out),
 * the machines on that account and their name. A machine's activity and its place on the
 * account need a machine, so they are left out.
 */
export function NoMachineProfilePage() {
  const account = useProfileAccount();
  return (
    <SettingsBody page="Profile">
      <PersonSection account={account} />
      {account.session && <AccountMachines />}
      <NameSetting />
      <Legal />
    </SettingsBody>
  );
}

const machineCount = (count: number) => (count === 1 ? "1 machine" : `${count} machines`);

/** The machines on the ace account, opened from Fleet. */
function AccountMachines() {
  const account = useAccountMachines(none);
  const names = account.only.map((machine) => machine.name);
  return (
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
  );
}
