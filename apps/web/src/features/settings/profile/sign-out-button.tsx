import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { accountSignOutQuestion } from "@/features/ace-account/index.ts";

/** Profile's Sign out: it asks first, saying what stops and that the person's work stays. */
/** What Sign out needs from the account: whether it's mid-change, and how to sign out. */
export interface SignOutTarget {
  busy: boolean;
  restoring: boolean;
  signOut(): Promise<unknown> | void;
}

export function SignOutButton(props: { account: SignOutTarget }) {
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
