import { WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { type DeckRun, type Gate } from "@ace/ui-core";
import { useDeckSender } from "./deck-source.ts";

const approveLabel: Record<Gate["kind"], string> = {
  plan: "Approve plan",
  merge: "Approve merge",
  escalation: "Approve",
};

/**
 * The gate above the plan: plan approval, merge approval or an escalation. The decision is a
 * `conductor.approve` command; the banner clears when the deck reports the gate closed.
 */
export function DeckGate(props: { run: DeckRun; gate: Gate }) {
  const send = useDeckSender();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const decide = async (decision: "approve" | "reject") => {
    setSending(true);
    try {
      await send({
        type: "conductor.approve",
        runId: props.run.id,
        approval: { gateId: props.gate.id, decision },
      });
      toast.add({
        title:
          decision === "approve"
            ? props.gate.kind === "merge"
              ? "Merge approved"
              : props.gate.kind === "plan"
                ? "Deck plan approved · lanes are starting"
                : "Approved · the deck carries on"
            : "Rejected · the deck keeps its current course",
      });
    } catch (error) {
      toast.add({ title: error instanceof Error ? error.message : "The deck didn't answer." });
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      aria-label={props.gate.title}
      className="mt-[22px] flex flex-wrap items-center gap-3.5 rounded-lg bg-[color-mix(in_oklab,var(--status-needs-you)_9%,transparent)] py-3.5 pr-4 pl-[18px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--status-needs-you)_30%,transparent)]"
    >
      <Icon icon={WarningIcon} size={20} className="text-status-needs-you" />
      <div className="min-w-0 flex-1 basis-[min(100%,360px)]">
        <h2 className="mb-0.5 text-base font-medium">{props.gate.title}</h2>
        {props.run.gates > 1 && (
          <p className="text-sm text-subtle-foreground">
            {props.run.gates - 1} more {props.run.gates === 2 ? "decision waits" : "decisions wait"}{" "}
            after this one
          </p>
        )}
        <p className="text-ui leading-[1.45] text-muted-foreground">{props.gate.body}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button variant="ghost" disabled={sending} onClick={() => void decide("reject")}>
          Reject
        </Button>
        <Button variant="primary" disabled={sending} onClick={() => void decide("approve")}>
          {approveLabel[props.gate.kind]}
        </Button>
      </div>
    </section>
  );
}
