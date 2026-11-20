import type { MachineAccountStatus } from "@ace/protocol";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAceAccount } from "./account-context.tsx";
import type { MachineAccountAccess } from "./machine-account-state.ts";
import { machineOwnerRow, notYouSteps } from "./machine-owner-copy.ts";

/**
 * Who the machine belongs to (ADR 0190 §3a): the account that acts as the person there. Its
 * owner can let it go from here; anyone else is told how to take it back.
 */
export function MachineOwnerRow(props: {
  status: MachineAccountStatus;
  access: MachineAccountAccess;
  onReleased(): void;
}) {
  const { session } = useAceAccount();
  const row = machineOwnerRow(props.status, session?.account);
  const [confirming, setConfirming] = useState<Confirming>();
  const [explaining, setExplaining] = useState(false);
  const release = useMutation({
    mutationFn: async () => {
      if (!(await props.access.releaseOwner()))
        throw new Error(
          "This window hasn't proved it's you on this machine yet. Wait a moment and try again.",
        );
    },
    onSuccess: props.onReleased,
  });
  if (!row) return null;
  return (
    <>
      <SettingRow id="machine.owner" title="Owner" description={row.sentence} inline>
        {row.action === "release" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={release.isPending}
            onClick={() =>
              setConfirming({
                title: "Let this machine go?",
                body: "It stops acting as you, and the next account to use it from the ace app owns it. Devices you paired stay paired, but need pairing again to act as you.",
                confirm: "Let it go",
                run: () => release.mutate(),
              })
            }
          >
            Let it go
          </Button>
        )}
        {row.action === "notYou" && (
          <Button size="sm" variant="ghost" onClick={() => setExplaining((open) => !open)}>
            Not you?
          </Button>
        )}
      </SettingRow>
      {explaining && row.action === "notYou" && <SettingNote>{notYouSteps}</SettingNote>}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
      {release.isError && (
        <SettingNote role="alert" className="text-destructive">
          {release.error.message}
        </SettingNote>
      )}
    </>
  );
}
