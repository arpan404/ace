import { Link } from "@tanstack/react-router";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAccountMachines, useAceAccount } from "@/features/ace-account/index.ts";
import { useMachines, usePrimaryMachine } from "@/lib/machines.ts";
import { ProfileIdentity, ProfileNameSettings } from "./ace-account.tsx";
import { MachineAccount } from "./machine-account.tsx";
import { settingRow } from "./settings-index.ts";

/**
 * Profile: the person and their ace account. Who they are and signing in or out; once signed
 * in, this computer's place on the account and a summary of the account's machines (the list
 * itself lives in Fleet); the name shown beside their messages; and the account's terms.
 */
export function ProfileSettings() {
  const { session } = useAceAccount();
  return (
    <>
      <ProfileIdentity />
      {session && <ProfileMachines />}
      <ProfileNameSettings />
      <nav aria-label="Legal" className="flex gap-4 text-sm text-subtle-foreground">
        <a
          href="https://acehq.dev/terms-of-service"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-border underline-offset-3 hover:text-foreground"
        >
          Terms of service
        </a>
        <a
          href="https://acehq.dev/privacy-policy"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-border underline-offset-3 hover:text-foreground"
        >
          Privacy policy
        </a>
      </nav>
    </>
  );
}

/** "3 machines", "1 machine". */
function machineCount(count: number): string {
  return count === 1 ? "1 machine" : `${count} machines`;
}

function ProfileMachines() {
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
