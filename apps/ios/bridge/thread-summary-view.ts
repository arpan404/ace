import type {
  Agent,
  Item,
  LinkedPullRequest,
  Thread,
  ThreadCatchUpResponse,
  TodoEntry,
  ToolStatus,
  TurnSummary,
} from "@ace/protocol";
import {
  catchUpLines,
  changesByAgent,
  checkOutcome,
  checkWords,
  digestLines,
  filesChangedWords,
  foldWords,
  forestNow,
  forestTally,
  joinNames,
  latestChecks,
  linkedChecks,
  mainAgentError,
  nowLine,
  otherCommandFailures,
  planCount,
  pluralCount,
  summaryAsker,
  summaryPrLine,
  summaryPrRows,
  summaryPullRequests,
  todoStatusWords,
  turnAgentFiles,
  type AgentForest,
  type ThreadWork,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * The open thread's Summary as the phone draws it, worded by the web Summary tab's own rules
 * (`@ace/ui-core`): Now, Since you looked, the agent tree's count, Results (pull requests, files
 * changed and by whom, checks, failed commands) and the plan. Every section is left out when it
 * has nothing to say. Pure: the facts come in, the clock is `now`.
 */

/** A shown plan: whose list it is and its items. */
export interface SummaryPlan {
  agentId: string;
  todos: readonly TodoEntry[];
}

export interface SummaryFacts {
  threadId: string;
  thread: Pick<Thread, "status" | "details" | "workspaceId">;
  forest: AgentForest;
  works: ReadonlyMap<string, ThreadWork>;
  turn: TurnSummary | undefined;
  /** The catch-up still worth showing: read, with something in it, and not cleared. */
  catchUp: ThreadCatchUpResponse | undefined;
  plans: readonly SummaryPlan[];
  showClosed: boolean;
  now: number;
  /** An agent's name as its tree row says it, in the thread it lives in. */
  name(threadId: string, agent: Agent): string;
  /** The open thread's agent and items, for the files' authors and the checks' steps. */
  agent(id: string): Agent | undefined;
  item(id: string): Item | undefined;
}

type Tone = "plain" | "needs-you" | "failed";

export interface SummaryView {
  /** The thread's project, where its pull requests open. */
  workspaceId: string;
  now: {
    say: string;
    lead: string;
    span: string | null;
    sub: string;
    tone: Tone;
    speak: string;
    /** Open: the asking agent elsewhere in the tree, by name. */
    open: { threadId: string; agentId: string; childThreadId: string | null; name: string } | null;
  };
  catchUp: { text: string; tone: Tone }[];
  /** The tree's count, once there is a tree beyond the main agent. */
  agents: string | null;
  prs: {
    id: string;
    title: string;
    line: string;
    url: string;
    number: number;
    repository: { forge: string; host: string; owner: string; name: string };
  }[];
  prFold: string | null;
  files: { title: string; detail: string; conflicts: string[] } | null;
  checks: { text: string; failed: boolean }[];
  commands: { ran: string; failed: string } | null;
  plan: {
    count: string;
    done: number;
    total: number;
    todos: { id: string; text: string; status: TodoEntry["status"]; words: string }[];
  } | null;
}

const toolStatus = (item: Item | undefined): ToolStatus | undefined =>
  item?.type === "tool_call" ? item.call.status : undefined;

function nowView(facts: SummaryFacts, prs: readonly LinkedPullRequest[], preview: Preview) {
  const asker = summaryAsker(facts.threadId, facts.forest, facts.works);
  const name = asker ? facts.name(asker.node.threadId, asker.node.agent) : "";
  const line = nowLine({
    status: facts.thread.status,
    // The whole tree, not just the thread's own status: never done while any branch is live.
    ...forestNow(facts.forest),
    turn: facts.turn && {
      startedAt: facts.turn.startedAt,
      endedAt: facts.turn.endedAt,
      said: facts.turn.latestAgentMessagePreview,
    },
    prs,
    now: facts.now,
    asker: asker && { name, root: asker.root, request: asker.request },
    error: mainAgentError(facts.forest),
  });
  return {
    say: preview(line.say, 256),
    lead: preview(line.lead, 256),
    span: line.span ?? null,
    sub: preview(line.sub, 512),
    tone: line.tone,
    speak: preview(line.speak, 256),
    open: asker?.open
      ? {
          threadId: asker.open.threadId,
          agentId: asker.open.agentId,
          childThreadId: asker.open.childThreadId ?? null,
          name: preview(name, 128),
        }
      : null,
  };
}

function filesView(facts: SummaryFacts, preview: Preview): SummaryView["files"] {
  const { turn } = facts;
  if (!turn?.digest.files.length) return null;
  const details = facts.thread.details;
  const worktree = details?.worktree ?? details?.workspace?.path ?? "";
  const changes = changesByAgent(turnAgentFiles(turn, (id) => facts.agent(id)?.cwd, worktree));
  const shared = new Map<string, string>(
    turn.subagents.flatMap((share) => (share.name ? [[share.agentId, share.name] as const] : [])),
  );
  const named = (id: string) => {
    const agent = facts.agent(id);
    return preview(agent ? facts.name(facts.threadId, agent) : (shared.get(id) ?? "An agent"), 128);
  };
  const lines = digestLines(turn.digest);
  const agents = changes.worktrees.flatMap((tree) => tree.agents);
  const by =
    agents.length > 1
      ? `by ${joinNames(agents.map((agent) => `${named(agent.agentId)} (${agent.truncated ? `${agent.files.length}+` : agent.files.length})`))}`
      : "";
  return {
    title: filesChangedWords(turn.digest),
    detail: [lines ? `+${lines.added} −${lines.removed}` : "", by].filter(Boolean).join(" · "),
    conflicts: changes.conflicts.map(
      (conflict) =>
        `${preview(conflict.path, 512)} was changed by ${joinNames(conflict.agents.map(named))} in the same checkout`,
    ),
  };
}

function planView(plans: readonly SummaryPlan[], preview: Preview): SummaryView["plan"] {
  const todos = plans.flatMap((plan) =>
    plan.todos.map((todo, index) => ({
      id: `${plan.agentId}:${todo.id ?? index}`,
      text: preview(todo.content, 512),
      status: todo.status,
      words: todoStatusWords(todo.status),
    })),
  );
  if (!todos.length) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  return { count: planCount({ done, total: todos.length }), done, total: todos.length, todos };
}

export function summaryView(facts: SummaryFacts, preview: Preview): SummaryView {
  const prs = summaryPullRequests(facts.thread.details?.linkedPrs ?? []);
  const { rows, fold } = summaryPrRows(prs, facts.showClosed);
  const { turn } = facts;
  const checks = turn ? latestChecks(turn.digest.commands) : [];
  const others = otherCommandFailures(turn?.digest, checks);
  const roots = facts.forest.roots;
  // A main agent alone says nothing Now hasn't: the tree shows once there is a tree.
  const tree = roots.some((root) => root.children.length > 0) || roots.length > 1;
  return {
    workspaceId: facts.thread.workspaceId,
    now: nowView(facts, prs, preview),
    catchUp: facts.catchUp
      ? catchUpLines(facts.catchUp).map((line) => ({
          text: preview(line.text, 512),
          tone: line.tone ?? "plain",
        }))
      : [],
    agents: tree ? foldWords(forestTally(roots)) || null : null,
    prs: rows.map((pr) => ({
      id: `${pr.repo.owner}/${pr.repo.name}#${pr.number}`,
      title: preview(pr.title ?? `#${pr.number}`, 256),
      line: summaryPrLine(pr, linkedChecks(pr)),
      url: pr.url,
      number: pr.number,
      repository: {
        forge: pr.repo.forge,
        host: pr.repo.host,
        owner: pr.repo.owner,
        name: pr.repo.name,
      },
    })),
    prFold: fold ?? null,
    files: filesView(facts, preview),
    checks: checks.map((check) => {
      const outcome = checkOutcome(check, toolStatus(facts.item(check.itemId)));
      return { text: checkWords(check, outcome), failed: outcome === "failed" };
    }),
    commands:
      turn && others > 0
        ? {
            ran: `${pluralCount(turn.digest.commandsRun, "command")} ran`,
            failed: `${others} failed`,
          }
        : null,
    plan: planView(facts.plans, preview),
  };
}
