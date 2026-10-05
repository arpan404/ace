import {
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  DotsThreeIcon,
  ProhibitIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense, useId, useState } from "react";
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
import { Input } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import {
  cardColumns,
  formatAge,
  gateDecision,
  raisedBudget,
  type DeckPlan,
  type DeckRun,
  type Gate,
  type GateDecision,
} from "@ace/ui-core";
import type { ConductorCommandPayload } from "@ace/protocol";
import { useHotkey } from "@/lib/hotkeys.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { deckKeys, failure, useDeckToast } from "./deck-keys.ts";
import { useDeckSender } from "./deck-source.ts";
import { changesThread, ViewChanges } from "./lane-detail.tsx";

type Approval = Extract<ConductorCommandPayload, { type: "conductor.approve" }>["approval"];

const gateFrame =
  "rounded-lg bg-status-needs-you/9 py-3.5 pr-4 pl-[18px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--status-needs-you)_30%,transparent)]";

/** Focus never sits in a field when a shortcut answers for the person. */
function typing(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement && !!active.closest("input, textarea, select, [contenteditable]")
  );
}

/**
 * Every decision a deck waits on, one at a time: the first to take, with Previous and Next and
 * the rest listed on request. `gates` narrows them (a lane tab shows only its card's).
 */
export function DeckGates(props: {
  run: DeckRun;
  gates?: readonly Gate[];
  onOpenCard(cardId: string): void;
  /** Beside a thread: no icon column, buttons wrap, no global shortcut. */
  compact?: boolean;
  /** The thread the gates are shown beside. */
  scope?: string;
}) {
  const gates = props.gates ?? props.run.gates;
  const [picked, setPicked] = useState<string>();
  const index = Math.max(
    0,
    gates.findIndex((gate) => gate.id === picked),
  );
  const gate = gates[index];
  if (!gate) return null;
  const nav =
    gates.length > 1 ? (
      <GateNav
        gates={gates}
        index={index}
        run={props.run}
        onPick={(next) => {
          setPicked(next.id);
          if (next.workstream) props.onOpenCard(next.workstream);
        }}
      />
    ) : null;
  return (
    <DeckGate
      key={gate.id}
      run={props.run}
      gate={gate}
      onOpenCard={props.onOpenCard}
      compact={props.compact ?? false}
      nav={nav}
    />
  );
}

/**
 * One gate: plan approval, a card's merge or escalation, a budget or deadline, or an agent's
 * own question. A deck decision is a `conductor.approve` command; an agent's question is
 * answered in place through its thread (`interaction.resolve`). The banner clears when the deck
 * reports the gate closed.
 */
export function DeckGate(props: {
  run: DeckRun;
  gate: Gate;
  onOpenCard(cardId: string): void;
  compact?: boolean;
  nav?: React.ReactNode;
}) {
  if (props.gate.interaction)
    return (
      <AgentQuestion
        run={props.run}
        gate={props.gate}
        nav={props.nav}
        compact={props.compact ?? false}
        {...props.gate.interaction}
      />
    );
  return <DeckDecision {...props} compact={props.compact ?? false} />;
}

/** "Waiting 4m": how long the deck has waited on this decision. */
function GateMeta(props: { gate: Gate }) {
  const now = useNow();
  if (props.gate.gatedAt <= 0) return null;
  const age = formatAge(props.gate.gatedAt, now);
  return (
    <p className="text-sm text-muted-foreground tabular-nums">
      Waiting {age === "now" ? "since just now" : age}
    </p>
  );
}

/** Decision n of m, Previous and Next, and every open decision on request. */
function GateNav(props: {
  run: DeckRun;
  gates: readonly Gate[];
  index: number;
  onPick(gate: Gate): void;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow();
  const list = useId();
  const { gates, index } = props;
  const titleOf = (gate: Gate) => props.run.cards.find((c) => c.id === gate.workstream)?.title;
  const step = (delta: number) => {
    const next = gates[index + delta];
    if (next) props.onPick(next);
  };
  return (
    <div className="mt-3 border-t pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <IconButton
          icon={CaretLeftIcon}
          label="Previous decision"
          size="sm"
          disabled={index === 0}
          onClick={() => step(-1)}
        />
        <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
          Decision {index + 1} of {gates.length}
        </span>
        <IconButton
          icon={CaretRightIcon}
          label="Next decision"
          size="sm"
          disabled={index === gates.length - 1}
          onClick={() => step(1)}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={list}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide the list" : `See all ${gates.length}`}
        </Button>
      </div>
      {open && (
        <ol id={list} aria-label="Open decisions" className="mt-1.5 flex flex-col">
          {gates.map((gate, at) => (
            <li key={gate.id}>
              <button
                type="button"
                aria-current={at === index || undefined}
                onClick={() => props.onPick(gate)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md px-2 py-1.5 text-left text-ui outline-none hover:bg-accent focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]"
              >
                {/* WP-1: focus-ring-inset */}
                <span className="min-w-0 truncate">
                  {gate.title}
                  {titleOf(gate) && !gate.title.includes(titleOf(gate) ?? "") && (
                    <span className="text-muted-foreground"> · {titleOf(gate)}</span>
                  )}
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {gate.gatedAt > 0 ? formatAge(gate.gatedAt, now) : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** An agent's question or approval, with the card it holds up and its thread. */
function AgentQuestion(props: {
  run: DeckRun;
  gate: Gate;
  threadId: string;
  interactionId: string;
  nav: React.ReactNode;
  compact: boolean;
}) {
  return (
    <section aria-label={props.gate.title} className={gateFrame}>
      <div className="flex flex-wrap items-center gap-3.5">
        {!props.compact && (
          <Icon icon={ChatCircleDotsIcon} size={20} className="text-status-needs-you" />
        )}
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="mb-0.5 text-base font-medium">{props.gate.title}</h2>
          <GateMeta gate={props.gate} />
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
      {props.nav}
    </section>
  );
}

const extensions = [
  { value: "1h", label: "1 hour", ms: 3_600_000 },
  { value: "4h", label: "4 hours", ms: 4 * 3_600_000 },
  { value: "1d", label: "1 day", ms: 24 * 3_600_000 },
] as const;
type Extension = (typeof extensions)[number]["value"];

function DeckDecision(props: {
  run: DeckRun;
  gate: Gate;
  onOpenCard(cardId: string): void;
  compact: boolean;
  nav?: React.ReactNode;
}) {
  const { run, gate } = props;
  const send = useDeckSender();
  const toast = useDeckToast();
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [budget, setBudget] = useState(() => String(raisedBudget(run.budget)));
  const [extension, setExtension] = useState<Extension>("4h");
  const card = run.cards.find((c) => c.id === gate.workstream);
  const decision = gateDecision(gate, card?.title);
  const thread = card && gate.ask === "merge" ? changesThread(card) : null;
  const raised = Number(budget);
  const raiseValid = Number.isFinite(raised) && raised > run.budget;
  const extend = extensions.find((entry) => entry.value === extension) ?? extensions[1];

  const answer = async (approval: Omit<Approval, "gateId">, done: string) => {
    setSending(true);
    try {
      await send({
        type: "conductor.approve",
        runId: run.id,
        approval: { gateId: gate.id, ...approval },
      });
      toast.done(done);
    } catch (error) {
      toast.error(failure(error));
    } finally {
      setSending(false);
    }
  };
  const approve = () => {
    if (sending) return;
    if (gate.ask === "budget") {
      if (raiseValid)
        void answer({ decision: "approve", budget: raised }, `Budget raised to ${raised}`);
    } else if (gate.ask === "deadline")
      void answer(
        { decision: "approve", deadline: Date.now() + extend.ms },
        `Deadline extended by ${extend.label}`,
      );
    else if (decision.approve) void answer({ decision: "approve" }, decision.approve.toast);
  };
  const reject = () => void answer({ decision: "reject" }, decision.reject.toast);

  useHotkey(
    deckKeys.deckApprove.keys,
    () => {
      if (!typing()) approve();
    },
    { enabled: !props.compact && !reviewing && !rejecting && gate.ask !== "budget" },
  );

  const approveLabel =
    gate.ask === "budget"
      ? raiseValid
        ? `Raise to ${raised}`
        : "Raise the budget"
      : gate.ask === "deadline"
        ? `Extend by ${extend.label}`
        : (decision.approve?.label ?? "Approve");
  const secondary =
    gate.ask === "plan" && run.plan ? (
      <Button variant="secondary" disabled={sending} onClick={() => setReviewing(true)}>
        Review plan
      </Button>
    ) : thread ? (
      <ViewChanges threadId={thread} variant="secondary" />
    ) : card ? (
      <Button variant="secondary" disabled={sending} onClick={() => props.onOpenCard(card.id)}>
        Open card
      </Button>
    ) : null;
  // Declining one card is a choice beside approving it; stopping the deck or redrafting the
  // plan is rarer, and sits behind the menu.
  const declineVisible = !decision.reject.stopsDeck && gate.ask !== "plan";

  return (
    <section
      aria-label={gate.title}
      className={cn(gateFrame, "flex flex-wrap items-start gap-3.5")}
    >
      {!props.compact && (
        <Icon icon={WarningIcon} size={20} className="mt-0.5 text-status-needs-you" />
      )}
      <div className="min-w-0 flex-1 basis-[min(100%,360px)]">
        <h2 className="mb-0.5 text-base font-medium">{gate.title}</h2>
        <GateMeta gate={gate} />
        <p className="mt-1 text-ui leading-[1.45] text-muted-foreground">{gate.body}</p>
        {gate.detail && (
          <details className="group mt-1.5 text-sm">
            <summary className="w-fit cursor-pointer rounded-xs text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]">
              {/* WP-1: focus-ring */}
              Details
            </summary>
            <pre
              className={cn(
                "mt-1.5 overflow-x-auto rounded-md bg-background px-2.5 py-2 font-mono text-xs leading-[1.5] whitespace-pre-wrap text-muted-foreground",
                gate.ask === "destructive" && "text-foreground",
              )}
            >
              {gate.detail}
            </pre>
          </details>
        )}
        {gate.ask === "budget" && (
          <form
            className="mt-2.5 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              approve();
            }}
          >
            <label className="text-sm text-muted-foreground" htmlFor={`${gate.id}-budget`}>
              New budget
            </label>
            <Input
              id={`${gate.id}-budget`}
              type="number"
              inputMode="numeric"
              min={run.budget + 1}
              step={1}
              value={budget}
              onChange={(event) => setBudget(event.currentTarget.value)}
              aria-invalid={!raiseValid || undefined}
              aria-describedby={`${gate.id}-budget-hint`}
              className="w-24 tabular-nums"
            />
            <span id={`${gate.id}-budget-hint`} className="text-sm text-muted-foreground">
              lane starts, more than {run.budget}
            </span>
          </form>
        )}
        {gate.ask === "deadline" && (
          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Extend by</span>
            <Select<Extension>
              label="Extend the deadline by"
              value={extension}
              options={extensions}
              onValueChange={setExtension}
            />
          </div>
        )}
      </div>
      <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
        {secondary}
        {declineVisible && (
          <Button variant="ghost" disabled={sending} onClick={() => setRejecting(true)}>
            {decision.reject.label}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={sending || (gate.ask === "budget" && !raiseValid)}
          onClick={approve}
          {...(!props.compact && gate.ask !== "budget"
            ? { "aria-keyshortcuts": "Meta+Enter" }
            : {})}
        >
          {approveLabel}
          {!props.compact && gate.ask !== "budget" && <ApproveKey />}
        </Button>
        {!declineVisible && (
          // Last, after the primary decision: the rarer choices sit at the edge.
          <Menu>
            <MenuTrigger
              render={<IconButton icon={DotsThreeIcon} label="More decisions" disabled={sending} />}
            />
            <MenuContent align="end">
              <MenuItem
                danger={decision.reject.stopsDeck}
                icon={<Icon icon={ProhibitIcon} />}
                onClick={() => setRejecting(true)}
              >
                {decision.reject.label}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {props.nav && <div className="basis-full">{props.nav}</div>}
      {reviewing && run.plan && (
        <PlanReview
          plan={run.plan}
          decision={decision}
          sending={sending}
          onApprove={() => {
            setReviewing(false);
            approve();
          }}
          onReject={() => {
            setReviewing(false);
            setRejecting(true);
          }}
          onClose={() => setReviewing(false)}
        />
      )}
      <RejectDialog
        open={rejecting}
        decision={decision}
        sending={sending}
        onOpenChange={setRejecting}
        onConfirm={() => {
          setRejecting(false);
          reject();
        }}
      />
    </section>
  );
}

/** Rejecting asks first, saying exactly what it does to the deck. */
function RejectDialog(props: {
  open: boolean;
  decision: GateDecision;
  sending: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const { reject } = props.decision;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reject.title}</DialogTitle>
          <DialogDescription>{reject.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            {reject.stopsDeck ? "Keep it running" : "Cancel"}
          </Button>
          <Button
            type="button"
            variant={reject.stopsDeck ? "danger" : "primary"}
            disabled={props.sending}
            onClick={props.onConfirm}
          >
            {reject.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The plan as the daemon holds it: each card, what it must do, how its reviewer judges it and
 * what it waits for; approved or sent back for another draft from here.
 */
function PlanReview(props: {
  plan: DeckPlan;
  decision: GateDecision;
  sending: boolean;
  onApprove(): void;
  onReject(): void;
  onClose(): void;
}) {
  const titles = new Map(props.plan.workstreams.map((w) => [w.id, w.title]));
  const stages = cardColumns(
    props.plan.workstreams.map((w) => ({
      id: w.id,
      title: w.title,
      dependencies: w.dependencies,
      state: "planned" as const,
      round: 0,
      lane: null,
      note: "",
      agents: [],
      startedAt: undefined,
      updatedAt: undefined,
    })),
  ).length;
  const count = props.plan.workstreams.length;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      {/* WP-1: DialogContent size="lg" with a max height and a scrolling body. */}
      <DialogContent className="flex max-h-[86vh] w-[min(640px,calc(100vw-2rem))] flex-col">
        <DialogHeader>
          <DialogTitle>The deck&apos;s plan</DialogTitle>
          <DialogDescription>
            {count} {count === 1 ? "card" : "cards"} in {stages} {stages === 1 ? "stage" : "stages"}
            . {props.plan.summary}
          </DialogDescription>
        </DialogHeader>
        <ol
          aria-label="Cards in this plan"
          className="-mx-1 flex min-h-0 flex-1 flex-col overflow-auto px-1"
        >
          {props.plan.workstreams.map((workstream) => (
            <li key={workstream.id} className="border-t py-3 text-ui first:border-t-0">
              <p className="font-medium">{workstream.title}</p>
              {workstream.objective !== workstream.title && (
                <p className="mt-0.5 text-muted-foreground">{workstream.objective}</p>
              )}
              {workstream.acceptance.length > 0 && (
                <ul
                  aria-label={`How ${workstream.title} is judged`}
                  className="mt-1.5 flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground marker:text-subtle-foreground"
                >
                  {workstream.acceptance.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              )}
              {workstream.dependencies.length > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  After {workstream.dependencies.map((id) => titles.get(id) ?? id).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ol>
        <DialogFooter className="border-t pt-3">
          <Button type="button" variant="ghost" disabled={props.sending} onClick={props.onReject}>
            {props.decision.reject.label}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={props.sending}
            onClick={props.onApprove}
            aria-keyshortcuts="Meta+Enter"
          >
            {props.decision.approve?.label ?? "Approve plan"}
            <ApproveKey />
          </Button>
        </DialogFooter>
        <PlanApproveKey onApprove={props.onApprove} />
      </DialogContent>
    </Dialog>
  );
}

/** ⌘↵ approves the plan from its review. */
function PlanApproveKey(props: { onApprove(): void }) {
  useHotkey(deckKeys.deckApprove.keys, props.onApprove);
  return null;
}

/** ⌘↵ beside the approve label: seen, not read as part of the button's name. */
function ApproveKey() {
  return (
    <span aria-hidden className="contents">
      <Kbd keys={deckKeys.deckApprove.keys} variant="bare" className="text-primary-foreground/60" />
    </span>
  );
}
