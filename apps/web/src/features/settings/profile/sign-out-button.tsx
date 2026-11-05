import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { accountSignOutQuestion } from "@/features/ace-account/index.ts";
import type { ProfileAccount } from "./account.tsx";

/** Profile's Sign out: it asks first, saying what stops and that the person's work stays. */
export function SignOutButton(props: { account: ProfileAccount }) {
  const { account } = props;
  const [confirming, setConfirming] = useState<Confirming>();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={account.busy || account.restoring}
        onClick={() =>
          setConfirming({
            ...accountSignOutQuestion(),
            run: () => void account.signOut(),
          })
        }
      >
        Sign out
      </Button>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}
