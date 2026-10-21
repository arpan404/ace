import { useState } from "react";
import type { AutomationTrigger } from "@ace/protocol";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useAutomationActions } from "./use-automations.ts";
import { triggerErrorCopy } from "./trigger-health.ts";
import { staleWriteMessage } from "./revision-conflicts.ts";

/** A stored trigger diagnostic with a safe retry once its definition is fixed. */
export function TriggerError(props: {
  trigger: AutomationTrigger;
  error: { message: string; at: number };
  revision: number | undefined;
  automationId: string;
  busy: boolean;
  onRetried(): void;
}) {
  const { retry } = useAutomationActions();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const disabled = props.busy || retrying;
  return (
    <div role="alert" className="mt-4 text-ui">
      <StatusLabel tone="failed" label="Trigger needs attention" />
      <p className="mt-1 text-sm text-muted-foreground">
        {triggerErrorCopy(props.trigger, props.error)}
      </p>
      <div className="mt-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setRetrying(true);
            retry(props.automationId, props.revision).then(
              () => {
                setRetrying(false);
                props.onRetried();
              },
              (error: unknown) => {
                setRetrying(false);
                toast.error({ title: staleWriteMessage(error) });
                props.onRetried();
              },
            );
          }}
        >
          Retry trigger
        </Button>
      </div>
    </div>
  );
}
