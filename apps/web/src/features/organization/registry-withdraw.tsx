import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/** The version a withdrawal is asked about. */
export interface Withdrawing {
  title: string;
  version: string;
  run(reason: string): void;
}

/**
 * Asks before a registry version is withdrawn, with the reason members' devices will show.
 * Focus starts on the reason; Withdraw stays off until there is one, so Enter never withdraws
 * by accident.
 */
export function WithdrawDialog(props: { withdrawing: Withdrawing | undefined; onDone(): void }) {
  const [reason, setReason] = useState("");
  const asked = props.withdrawing;
  const done = () => {
    setReason("");
    props.onDone();
  };
  const trimmed = reason.trim();
  return (
    <Dialog open={asked !== undefined} onOpenChange={(open) => !open && done()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Withdraw {asked?.title} {asked?.version}?
          </DialogTitle>
          <DialogDescription>
            It stays offered until the registry's signer signs the withdrawal. Machines that
            installed it keep it until then.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Why it's withdrawn"
          placeholder="Why it's withdrawn"
          value={reason}
          maxLength={500}
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={done}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={trimmed === ""}
            onClick={() => {
              asked?.run(trimmed);
              done();
            }}
          >
            Withdraw
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
