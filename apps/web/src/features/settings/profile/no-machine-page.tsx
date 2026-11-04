import { Link } from "@tanstack/react-router";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { settingRow } from "../settings-index.ts";
import { ProfileHero, useProfileAccount } from "./account.tsx";
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
    <Screen
      title="Profile"
      namedByPanel
      actions={
        account.session ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={account.busy || account.restoring}
            onClick={() => void account.signOut()}
          >
            Sign out
          </Button>
        ) : undefined
      }
    >
      <div className="h-full overflow-auto">
        <div className="@container mx-auto flex w-full max-w-[52rem] flex-col gap-12 px-5 pt-12 pb-20 sm:px-8">
          <ProfileHero account={account} />
          <div className="flex flex-col">
            {account.session && <AccountMachines />}
            <NameSetting />
          </div>
          <Legal />
        </div>
      </div>
    </Screen>
  );
}

const machineCount = (count: number) => (count === 1 ? "1 computer" : `${count} computers`);

/** The machines on the ace account, opened from Fleet. */
function AccountMachines() {
  const account = useAccountMachines(none);
  const names = account.only.map((machine) => machine.name);
  return (
    <SettingSection label="Computers on your account" card>
      <SettingRow
        {...settingRow("profile.machines")}
        title={names.length ? machineCount(names.length) : "No computers yet"}
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
