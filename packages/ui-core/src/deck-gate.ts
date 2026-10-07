import type { ConductorRunView } from "@ace/protocol";
import type { Gate } from "./deck.ts";

/*
 * A deck's title and its open decisions, from the conductor view. Kept apart from the full
 * mapper (deck-view.ts): the sidebar counts open decisions on every screen.
 */

type View = ConductorRunView;
type NeedsUser = View["needsUser"][number];

/** "Make every relay stream resumable": the goal's first sentence, short enough for a title. */
export function deckTitle(goal: string): string {
  // A sentence ends at a stop followed by a space or the end, so "0.48" stays whole.
  const first = goal.split(/[.!?](?:\s|$)|\n/)[0]?.trim() || goal.trim();
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

/**
 * Which decision comes first: a card stopped on a person (an escalation, an agent's question),
 * then what risks work (destructive changes, budget, deadline), then merges, then the plan.
 */
const gateOrder: Record<NeedsUser["kind"], number> = {
  escalation: 0,
  provider: 1,
  destructive: 2,
  budget: 3,
  deadline: 4,
  merge: 5,
  plan: 6,
};

function gateTitle(gate: NeedsUser, card: string | undefined): string {
  switch (gate.kind) {
    case "plan":
      return "Deck plan needs your approval";
    case "merge":
      return card ? `Merge needs your approval: ${card}` : "Merge needs your approval";
    case "budget":
      return "The deck used its budget";
    case "deadline":
      return "The deck passed its deadline";
    case "destructive":
      return card ? `Destructive change in ${card}` : "A destructive change needs approval";
    case "escalation":
      return card ? `Escalated: ${card}` : "The deck escalated a decision";
    case "provider":
      return card ? `${card} needs your answer` : "An agent needs your answer";
  }
}

/** What the agent is asking, from the daemon's "question needs your answer". */
const providerAsks: Record<string, string> = {
  question: "The agent asked a question. It continues once you answer.",
  approval: "The agent wants to run something that needs your approval.",
  plan_review: "The agent proposed a plan and waits for your review.",
  elicitation: "A tool the agent uses needs input from you.",
};

const roleNames: Record<string, string> = {
  planner: "planner",
  worker: "worker",
  reviewer: "reviewer",
  integrator: "fix",
};

/** The conductor's machine lines for an escalation (lane-status.ts, reducer.ts), in words. */
function escalationBody(message: string, card: string, role: string): string | undefined {
  const lane = /^Lane \S+ is (unresponsive|failed|limited)$/.exec(message)?.[1];
  if (lane === "unresponsive") return `${card}'s ${role} stopped responding.`;
  if (lane === "failed") return `${card}'s ${role} failed.`;
  if (lane === "limited") return `${card}'s ${role} hit its account's limit.`;
  if (/^Lane \S+ stalled$/.test(message)) return `${card}'s ${role} stopped making progress.`;
  if (/^Lane \S+ is done without its \w+ artifact$/.test(message))
    return `${card}'s ${role} finished without reporting its result.`;
  if (/retention limit reached/.test(message))
    return "This card has had too many review rounds. Start a new deck for it.";
  if (message === "Deck PR head or CI did not pass")
    return `${card} merged, but CI didn't pass at the reviewed revision.`;
  if (message === "Deck integration revision or worktree changed")
    return `${card} merged, but the deck's branch changed before it could be checked.`;
  return undefined;
}

/** The gate in words; the daemon's own line stays as `detail` whenever it is reworded. */
function gateText(
  gate: NeedsUser,
  card: string | undefined,
  view: GateView,
): { body: string; detail: string | undefined } {
  const raw = { body: gate.message, detail: undefined };
  switch (gate.kind) {
    case "provider": {
      const kind = /^(\w+) needs your answer$/.exec(gate.message)?.[1];
      return { body: (kind && providerAsks[kind]) ?? gate.message, detail: undefined };
    }
    case "merge": {
      const merge = /^Merge \S+ at ([0-9a-f]{7,64})$/.exec(gate.message);
      if (!merge?.[1]) return raw;
      return {
        body: `${card ?? "The card"} passed review at ${merge[1].slice(0, 7)}. Approve to merge it into the deck's branch.`,
        detail: gate.message,
      };
    }
    case "budget":
      return view.budget > 0
        ? {
            body: `${view.spent} of ${view.budget} lane starts used. Raise the budget to keep going.`,
            detail: gate.message,
          }
        : raw;
    case "deadline":
      return {
        body: "The deck stops starting work at its deadline. Extend it to keep going.",
        detail: undefined,
      };
    case "destructive":
      return {
        body: `An agent${card ? ` on ${card}` : ""} wants to make a change that can't be undone.`,
        detail: gate.message,
      };
    case "escalation": {
      const lane = view.lanes?.find((entry) => entry.id === gate.lane);
      const role = roleNames[lane?.role ?? "worker"] ?? "lane";
      const body = escalationBody(gate.message, card ?? "The card", role);
      return body ? { body, detail: gate.message } : raw;
    }
    case "plan":
      return raw;
  }
}

/** What a gate needs from the view: card titles, spend for a budget, lanes for an escalation. */
type GateView = Pick<View, "needsUser" | "dag"> &
  Partial<Pick<View, "lanes">> & { spent: number; budget: number };

function gateOf(gate: NeedsUser, view: GateView): Gate {
  const card = view.dag.find((node) => node.id === gate.workstream)?.title;
  const kind =
    gate.kind === "plan" || gate.kind === "merge" || gate.kind === "provider"
      ? gate.kind
      : "escalation";
  return {
    id: gate.id,
    kind,
    ask: gate.kind,
    title: gateTitle(gate, card),
    ...gateText(gate, card, view),
    workstream: gate.workstream,
    gatedAt: gate.gatedAt,
    interaction:
      gate.kind === "provider" && gate.threadId && gate.interactionId
        ? { threadId: gate.threadId, interactionId: gate.interactionId }
        : null,
  };
}

/**
 * Every decision a deck waits on, in the order to take them; within a kind, the one waiting
 * longest first.
 */
export function deckGates(view: GateView): Gate[] {
  return view.needsUser
    .toSorted((a, b) => gateOrder[a.kind] - gateOrder[b.kind] || a.gatedAt - b.gatedAt)
    .map((gate) => gateOf(gate, view));
}

/** The decision a deck waits on first. */
export function deckGate(view: GateView): Gate | null {
  return deckGates(view)[0] ?? null;
}

/**
 * What raising a budget gate offers: the budget plus half again, and at least ten more lane
 * starts.
 */
export function raisedBudget(budget: number): number {
  return budget + Math.max(10, Math.ceil(budget / 2));
}

const waits = new Map([
  [
    "deck_capacity_wait",
    {
      title: "Waiting for a free account.",
      body: "Every account the deck may use is busy. It carries on when one frees up.",
    },
  ],
  [
    "deck_migration_pending",
    { title: "Waiting for account migration.", body: "A lane is still moving to another account." },
  ],
  [
    "deck_ci_pending",
    {
      title: "Waiting for CI.",
      body: "The deck's pull request is waiting for its checks to finish.",
    },
  ],
  [
    "deck_forge_executor_unavailable",
    {
      title: "Waiting for the PR service.",
      body: "The daemon needs its PR service before the deck can carry on.",
    },
  ],
  [
    "git_quarantined",
    {
      title: "Waiting for Git recovery.",
      body: "Git operations are held while the daemon recovers the repository.",
    },
  ],
]);

/** Executor waits retried by the daemon, with the reason named on the run page. */
export function deckWaitText(code: string): { title: string; body: string } | undefined {
  return waits.get(code);
}

const executionErrors = new Map([
  ["deck_workspace_not_found", "The deck's project is no longer on this daemon."],
  ["deck_planner_missing", "The deck has no planner model to start with."],
  ["deck_root_agent_missing", "The daemon couldn't start the deck's own thread."],
  ["deck_root_missing", "The deck lost its own thread."],
  ["deck_lane_binding_missing", "The daemon lost track of one of the deck's lanes."],
  ["deck_engine_unavailable", "The daemon's agent engine isn't running."],
  [
    "deck_pr_revision_changed",
    "The pull request changed since review. Restore the reviewed revision before continuing.",
  ],
  [
    "deck_branch_identity_changed",
    "The deck's branch changed outside this run. Restore its recorded revision before continuing.",
  ],
  [
    "deck_worktree_identity_changed",
    "A deck worktree no longer matches its recorded branch and revision.",
  ],
  ["deck_run_context_missing", "The daemon couldn't find the run needed for this step."],
  [
    "deck_destructive_gate_requires_provider_approval",
    "This change needs approval on the provider's own thread.",
  ],
  ["deck_cancelled", "The deck was cancelled before this step could finish."],
]);

/** Execution failures are explained in words, including an unknown daemon code. */
export function deckErrorText(code: string): string {
  return (
    deckWaitText(code)?.body ??
    executionErrors.get(code) ??
    "The daemon couldn't run the deck's next step."
  );
}

const commandErrors = new Map([
  ["stale_gate", "That decision is out of date. The deck has moved on."],
  ["gate_not_pending", "That decision is out of date. The deck has moved on."],
  ["conductor_unavailable", "This daemon's Deck service isn't running."],
  ["conductor_executor_unavailable", "This daemon can't run decks: its conductor has no executor."],
  ["conductor_command_failed", "The daemon couldn't apply that to the deck."],
  ["conductor_invalid_spec", "The deck's settings aren't valid. Check its models and limits."],
  [
    "conductor_invalid_root_agent",
    "The daemon couldn't use the deck's root agent identity. Start a new deck.",
  ],
  [
    "conductor_workspace_not_found",
    "This project is no longer on the daemon. Choose another project.",
  ],
  ["conductor_workspace_not_git", "This project needs a Git repository before a deck can start."],
  [
    "conductor_provider_unavailable",
    "A provider selected for this deck isn't installed on the daemon.",
  ],
  [
    "conductor_account_unavailable",
    "A selected provider has no usable account. Check its login and the deck's accounts.",
  ],
  ["budget_must_increase", "Raise the budget above what the deck has now."],
  ["deadline_must_be_future", "Pick a deadline later than now."],
  ["merge_not_ready", "That card can't merge yet."],
  ["plan_missing", "The deck needs a plan before it can be approved."],
  ["lane_not_live", "That lane has stopped. Refresh the deck before answering."],
  ["run_not_found", "This deck is no longer on the daemon."],
  ["run_retention_limit", "This deck has reached its review limit. Start a new deck."],
  ["input_backpressure", "The deck is handling too many updates. Try again when it catches up."],
  [
    "control_backpressure",
    "The deck is handling too many decisions. Try again when it catches up.",
  ],
  ["effect_backpressure", "The deck has too many pending steps. Try again when it catches up."],
  [
    "actor_backpressure",
    "The daemon has too many active decks. Finish one before starting another.",
  ],
  ["already_exists", "A deck with that id already exists."],
  ["not_running", "The deck isn't running."],
  ["not_paused", "The deck isn't paused."],
  ["finished", "The deck has already finished."],
  ["run_limit", "This daemon holds as many decks as it can. Remove an old one first."],
]);

/** Public conductor refusals shared by every client. Unknown codes use its ordinary fallback. */
export function deckCommandErrorText(code: string): string | undefined {
  return commandErrors.get(code);
}

/** Rejecting what stops the whole deck, as `conductor.cancel` does. */
const stopDeck = {
  label: "Stop the deck…",
  title: "Reject and cancel this deck?",
  body: "Every lane stops and nothing else merges. Cards already merged stay on the deck's branch.",
  confirm: "Cancel deck",
  toast: "Stopping the deck",
  stopsDeck: true,
};

export interface GateDecision {
  /** The one-click answer; null when the deck needs a value first (a budget, a deadline). */
  approve: { label: string; toast: string } | null;
  /** What rejecting does, as the conductor applies it (packages/conductor approval.ts). */
  reject: {
    label: string;
    title: string;
    body: string;
    confirm: string;
    toast: string;
    /** It cancels the deck, rather than dropping one plan or declining one card. */
    stopsDeck: boolean;
  };
}

/**
 * How a conductor gate is answered, in words: approving a plan starts it, approving an escalation
 * retries its card; rejecting redrafts a plan, declines the card a gate is about, and otherwise
 * stops the deck. `card` is the title of the card the gate is about.
 */
export function gateDecision(gate: Pick<Gate, "ask" | "workstream">, card?: string): GateDecision {
  const name = card ?? "this card";
  const decline = {
    label: "Decline card…",
    title: `Decline ${name}?`,
    body: "It won't merge, and cards that depend on it won't start. The rest of the deck carries on.",
    confirm: "Decline card",
    toast: `Declined ${name} · the deck carries on`,
    stopsDeck: false,
  };
  const onCard = gate.workstream !== null;
  switch (gate.ask) {
    case "plan":
      return {
        approve: { label: "Approve plan", toast: "Deck plan approved · lanes are starting" },
        reject: {
          label: "Draft a new plan…",
          title: "Draft a new plan?",
          body: "The deck drops this plan and the planner drafts another. No lane has started yet.",
          confirm: "Draft again",
          toast: "Drafting a new plan",
          stopsDeck: false,
        },
      };
    case "merge":
      return {
        approve: { label: "Approve merge", toast: `Merging ${name}` },
        reject: onCard ? decline : stopDeck,
      };
    case "destructive":
      return {
        approve: { label: "Allow this change", toast: "Change allowed" },
        reject: onCard ? decline : stopDeck,
      };
    case "escalation":
    case "provider":
      return {
        approve: onCard
          ? { label: "Retry card", toast: `Retrying ${name}: a new round starts` }
          : { label: "Retry", toast: "Retrying" },
        reject: onCard ? decline : stopDeck,
      };
    case "budget":
    case "deadline":
      return { approve: null, reject: stopDeck };
  }
}
