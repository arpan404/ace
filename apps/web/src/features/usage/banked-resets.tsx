import { useRef, useState } from "react";
import type { AccountResetOutcome } from "@ace/protocol/accounts";
import type { AccountLimits } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";

export type RedeemReset = (
  entry: AccountLimits,
  idempotencyKey: string,
) => Promise<AccountResetOutcome>;
const outcomes: Record<AccountResetOutcome, string> = {
  reset: "Limits reset.",
  alreadyRedeemed: "This reset was already applied.",
  noCredit: "No banked resets remain.",
  nothingToReset: "There are no limits to reset yet.",
};

export function BankedResetAction(props: {
  entry: AccountLimits;
  redeem?: RedeemReset | undefined;
}) {
  const { entry, redeem } = props;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busy = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  if (entry.account.provider === "claude")
    return (
      <a
        className="mt-2 block text-xs text-link hover:underline focus-ring"
        href="https://claude.ai/settings/usage"
        target="_blank"
        rel="noreferrer"
      >
        Use reset in Claude
      </a>
    );
  if (entry.account.provider !== "codex" || !redeem) return null;
  const confirm = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const key = attempt ?? crypto.randomUUID();
    setAttempt(key);
    try {
      const result = await redeem(entry, key);
      setNotice(outcomes[result]);
      setAttempt(undefined);
      setOpen(false);
    } catch {
      setNotice("Couldn't confirm the reset. Retry to check the same attempt.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        className="mt-2"
        onClick={() => {
          setNotice(undefined);
          setOpen(true);
        }}
      >
        Use reset
      </Button>
      {notice && !open && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy.current) setOpen(next);
        }}
      >
        <DialogContent initialFocus={cancel} showCloseButton={!pending}>
          <DialogTitle>Use one banked reset?</DialogTitle>
          <DialogDescription>
            This spends one saved reset for {entry.account.label} on {entry.environment}. Codex
            decides which limits it resets.
          </DialogDescription>
          {notice && (
            <p role="status" className="text-ui text-muted-foreground">
              {notice}
            </p>
          )}
          <DialogFooter>
            <Button ref={cancel} disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending} onClick={() => void confirm()}>
              {pending ? "Applying…" : attempt ? "Retry reset" : "Use reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
