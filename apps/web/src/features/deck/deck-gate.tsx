import { DotsThreeIcon, ProhibitIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { type DeckPlan, type DeckRun, type Gate } from "@ace/ui-core";
import { useDeckSender } from "./deck-source.ts";

const approveLabel: Record<Gate["kind"], string> = {
  plan: "Approve plan",
  merge: "Approve merge",
  escalation: "Approve",
};

const rejectCopy: Record<Gate["kind"], { title: string; body: string }> = {
  plan: {
    title: "Reject this plan?",
    body: "The deck keeps its current plan and lanes; this revision is dropped.",
  },
  merge: {
    title: "Reject this merge?",
    body: "Nothing merges. The cards stay as they are until you decide again.",
  },
  escalation: {
    title: "Reject this request?",
    body: "The deck keeps its current course for this card.",
  },
};

/** The plan as the daemon holds it: each card, what it must do and what it waits for. */
function PlanReview(props: { plan: DeckPlan; onClose(): void }) {
  const titles = new Map(props.plan.workstreams.map((w) => [w.id, w.title]));
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>The deck&apos;s plan</DialogTitle>
          <DialogDescription>{props.plan.summary}</DialogDescription>
        </DialogHeader>
        <ol aria-label="Cards in this plan" className="flex max-h-[60vh] flex-col overflow-auto">
          {props.plan.workstreams.map((workstream) => (
            <li key={workstream.id} className="border-t py-3 text-ui first:border-t-0">
              <p className="font-medium">{workstream.title}</p>
              <p className="mt-0.5 text-muted-foreground">{workstream.objective}</p>
              {workstream.dependencies.length > 0 && (
                <p className="mt-1 text-xs text-subtle-foreground">
                  After {workstream.dependencies.map((id) => titles.get(id) ?? id).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The gate above the plan: plan approval, merge approval or an escalation. Review changes opens
 * the plan revision (or the card the gate is about); Reject sits in the gate's ⋯ and asks first.
 * The decision is a `conductor.approve` command; the banner clears when the deck reports the
 * gate closed.
 */
export function DeckGate(props: { run: DeckRun; gate: Gate; onOpenCard(cardId: string): void }) {
  const send = useDeckSender();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const { plan } = props.run;
  const workstream = props.gate.workstream;
  const review =
    props.gate.kind === "plan" && plan
      ? () => setReviewing(true)
      : workstream
        ? () => props.onOpenCard(workstream)
        : undefined;
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
        <Menu>
          <MenuTrigger
            render={<IconButton icon={DotsThreeIcon} label="More decisions" disabled={sending} />}
          />
          <MenuContent align="end">
            <MenuItem danger icon={<Icon icon={ProhibitIcon} />} onClick={() => setRejecting(true)}>
              Reject…
            </MenuItem>
          </MenuContent>
        </Menu>
        {review && (
          <Button variant="secondary" disabled={sending} onClick={review}>
            Review changes
          </Button>
        )}
        <Button variant="primary" disabled={sending} onClick={() => void decide("approve")}>
          {approveLabel[props.gate.kind]}
        </Button>
      </div>
      {reviewing && plan && <PlanReview plan={plan} onClose={() => setReviewing(false)} />}
      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rejectCopy[props.gate.kind].title}</DialogTitle>
            <DialogDescription>{rejectCopy[props.gate.kind].body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={sending}
              onClick={() => {
                setRejecting(false);
                void decide("reject");
              }}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
