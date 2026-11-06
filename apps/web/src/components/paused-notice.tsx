import { useOptionalClient } from "@ace/client-react";
import { useState } from "react";
import { setPaused, useAdmission } from "@/lib/admission.ts";
import { StatusLabel } from "./status-label.tsx";
import { Button } from "./ui/button.tsx";
import { useToast } from "./ui/toast.tsx";

/**
 * The person paused new work on this window's machine (the Fleet page, the desktop tray or a
 * phone): ongoing work keeps its own status. The daemon owns the pause, so this shows on the web
 * too, and Resume here clears it everywhere. A window with no machine has nothing to pause and
 * shows nothing.
 */
export function PausedNotice() {
  const client = useOptionalClient();
  const admission = useAdmission(client);
  const [pending, setPending] = useState(false);
  const toast = useToast();
  if (!client || !admission?.holds.includes("user")) return null;
  return (
    <div role="status" className="flex min-h-9 items-center gap-2 border-b px-4 text-ui">
      <StatusLabel tone="needs-you" label="Paused" />
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">New work is on hold.</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void setPaused(client, false, "this machine")
            .then((outcome) => {
              if (!outcome.ok)
                toast.error({ title: "Couldn't resume new work", description: outcome.problem });
            })
            .finally(() => setPending(false));
        }}
      >
        Resume
      </Button>
    </div>
  );
}
