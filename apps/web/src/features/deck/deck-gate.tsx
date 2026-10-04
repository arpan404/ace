import {
  ChatCircleDotsIcon,
  DotsThreeIcon,
  ProhibitIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense, useState } from "react";
// An agent's question is answered with the thread's own request card; its code loads only when
// a deck is waiting on one.
import { DeferredThreadInteraction as ThreadInteraction } from "@/features/thread/index.ts";
import { Icon } from "@/components/icon.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
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
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { formatAge, type DeckPlan, type DeckRun, type Gate } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { useDeckSender } from "./deck-source.ts";

type DeckDecisionKind = Exclude<Gate["kind"], "provider">;

const approveLabel: Record<DeckDecisionKind, string> = {
  plan: "Approve plan",
  merge: "Approve merge",
  escalation: "Approve",
};

const rejectCopy: Record<DeckDecisionKind, { title: string; body: string }> = {
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

/** "Waiting 4m · 1 more decision after this one". */
function GateMeta(props: { run: DeckRun; gate: Gate }) {
  const now = useNow();
  const more = props.run.gates.length - 1;
  const parts = [
    props.gate.gatedAt > 0
      ? `Waiting ${formatAge(props.gate.gatedAt, now) === "now" ? "since just now" : formatAge(props.gate.gatedAt, now)}`
      : undefined,
    more > 0
      ? `${more} more ${more === 1 ? "decision waits" : "decisions wait"} after this one`
      : undefined,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p className="text-sm text-subtle-foreground tabular-nums">{parts.join(" · ")}</p>;
}

const gateFrame =
  "mt-[22px] rounded-lg bg-[color-mix(in_oklab,var(--status-needs-you)_9%,transparent)] py-3.5 pr-4 pl-[18px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--status-needs-you)_30%,transparent)]";

/**
 * The gate above the plan: plan approval, merge approval, an escalation, or an agent's own
 * question. A deck decision is a `conductor.approve` command; an agent's question is answered
 * in place through its thread (`interaction.resolve`). The banner clears when the deck reports
 * the gate closed.
 */
export function DeckGate(props: { run: DeckRun; gate: Gate; onOpenCard(cardId: string): void }) {
  if (props.gate.interaction)
    return <AgentQuestion run={props.run} gate={props.gate} {...props.gate.interaction} />;
  return (
    <DeckDecision
      {...props}
      kind={props.gate.kind === "provider" ? "escalation" : props.gate.kind}
    />
  );
}

/** An agent's question or approval, with the card it holds up and its thread. */
function AgentQuestion(props: {
  run: DeckRun;
  gate: Gate;
  threadId: string;
  interactionId: string;
}) {
  return (
    <section aria-label={props.gate.title} className={gateFrame}>
      <div className="flex items-center gap-3.5">
        <Icon icon={ChatCircleDotsIcon} size={20} className="text-status-needs-you" />
        <div className="min-w-0 flex-1">
          <h2 className="mb-0.5 text-base font-medium">{props.gate.title}</h2>
          <GateMeta run={props.run} gate={props.gate} />
        </div>
        <Link
          to="/t/$threadId"
          params={{ threadId: props.threadId }}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open thread
        </Link>
      </div>
      <div className="mt-3 rounded-lg bg-background">
        <Suspense fallback={<SkeletonText lines={3} className="px-[18px] py-4" />}>
          <ThreadInteraction threadId={props.threadId} interactionId={props.interactionId} />
        </Suspense>
      </div>
    </section>
  );
}

function DeckDecision(props: {
  run: DeckRun;
  gate: Gate;
  kind: DeckDecisionKind;
  onOpenCard(cardId: string): void;
}) {
  const send = useDeckSender();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const { plan } = props.run;
  const workstream = props.gate.workstream;
  const review =
    props.kind === "plan" && plan
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
            ? props.kind === "merge"
              ? "Merge approved"
              : props.kind === "plan"
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
      className={cn(gateFrame, "flex flex-wrap items-center gap-3.5")}
    >
      <Icon icon={WarningIcon} size={20} className="text-status-needs-you" />
      <div className="min-w-0 flex-1 basis-[min(100%,360px)]">
        <h2 className="mb-0.5 text-base font-medium">{props.gate.title}</h2>
        <GateMeta run={props.run} gate={props.gate} />
        <p className="text-ui leading-[1.45] text-muted-foreground">{props.gate.body}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {review && (
          <Button variant="secondary" disabled={sending} onClick={review}>
            {props.kind === "plan" ? "Review plan" : "Open card"}
          </Button>
        )}
        <Button variant="primary" disabled={sending} onClick={() => void decide("approve")}>
          {approveLabel[props.kind]}
        </Button>
        {/* Last, after the primary decision: the rarer choices sit at the edge. */}
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
      </div>
      {reviewing && plan && <PlanReview plan={plan} onClose={() => setReviewing(false)} />}
      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rejectCopy[props.kind].title}</DialogTitle>
            <DialogDescription>{rejectCopy[props.kind].body}</DialogDescription>
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
