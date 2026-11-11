import type { SpadeStatus } from "@ace/protocol";
import type { SpadeCallState } from "./fold.ts";

/*
 * Spade's states and tools in words. Tool names are Spade's own (`web_search`) or an ace tool
 * it reaches through MCP; one this table doesn't know reads by its name.
 */

interface ToolWords {
  /** "search the web": after "Spade wants to". */
  base: string;
  /** "Searching the web": the Working line. */
  doing: string;
  /** "Searched the web": a call that ran. */
  done: string;
}

const tools: Record<string, ToolWords> = {
  web_search: { base: "search the web", doing: "Searching the web", done: "Searched the web" },
  web_fetch: { base: "read a web page", doing: "Reading a web page", done: "Read a web page" },
  todo: { base: "update its plan", doing: "Updating its plan", done: "Updated its plan" },
  tool_search: { base: "look for a tool", doing: "Looking for a tool", done: "Looked for a tool" },
  skill_search: {
    base: "look for a skill",
    doing: "Looking for a skill",
    done: "Looked for a skill",
  },
  call_tool: { base: "use a tool", doing: "Using a tool", done: "Used a tool" },
  send_email: { base: "send an email", doing: "Sending an email", done: "Sent an email" },
  research: { base: "research", doing: "Researching", done: "Researched" },
  delegate: {
    base: "hand work to agents",
    doing: "Handing work to agents",
    done: "Handed work to agents",
  },
  wait: { base: "wait for agents", doing: "Waiting for agents", done: "Waited for agents" },
  // ace's own tools, reached through its MCP endpoint.
  ace_threads_list: { base: "list your threads", doing: "Listing threads", done: "Listed threads" },
  ace_thread_read: { base: "read a thread", doing: "Reading a thread", done: "Read a thread" },
  ace_thread_status: {
    base: "check a thread",
    doing: "Checking a thread",
    done: "Checked a thread",
  },
  ace_thread_run: { base: "start a thread", doing: "Starting a thread", done: "Started a thread" },
  ace_thread_send: {
    base: "send a message to a thread",
    doing: "Sending a message to a thread",
    done: "Sent a message to a thread",
  },
  ace_task_control: {
    base: "control a task",
    doing: "Controlling a task",
    done: "Controlled a task",
  },
};

/** `ace__thread_start` or `ace_thread_start` → "thread start". */
function plainName(name: string): string {
  const last = (name.split("__").at(-1) ?? name).replace(/^ace_/, "");
  return last.replaceAll(/[_-]+/g, " ").trim() || name;
}

export function spadeToolWords(name: string): ToolWords {
  const known = tools[name];
  if (known) return known;
  const plain = plainName(name);
  return { base: `use ${plain}`, doing: `Using ${plain}`, done: `Used ${plain}` };
}

/** A call's line in a reply: what it did, or why it didn't. */
export function spadeCallLine(name: string, state: SpadeCallState): string {
  const words = spadeToolWords(name);
  switch (state) {
    case "done":
      return words.done;
    case "failed":
      return `Couldn't ${words.base}`;
    case "declined":
      return `You declined: ${words.base}`;
    case "skipped":
      return `Didn't ${words.base}`;
    case "waiting":
      return `Waiting for you: ${words.base}`;
    case "queued":
    case "running":
      return words.doing;
  }
}

/** The approval's one sentence: "Spade wants to send an email." */
export function spadeApprovalSentence(name: string): string {
  return `Spade wants to ${spadeToolWords(name).base}.`;
}

/** What the Spade place says about Spade itself, and whether it offers Turn on. */
export interface SpadeStateLine {
  sentence: string;
  /** Spade is ready for requests. */
  ready: boolean;
  /** The setting is off, so the person can turn it on. */
  canTurnOn: boolean;
}

/**
 * `enabled` is the `spade.enabled` setting (undefined while it loads). With it on, the daemon's
 * status says the rest: starting, running, or why it is off or stopped.
 */
export function spadeStateLine(
  status: SpadeStatus | undefined,
  enabled: boolean | undefined,
): SpadeStateLine {
  if (enabled === false) return { sentence: "Spade is off.", ready: false, canTurnOn: true };
  if (!status) return { sentence: "Checking Spade…", ready: false, canTurnOn: false };
  switch (status.state) {
    case "ready":
      return { sentence: "Spade is running.", ready: true, canTurnOn: false };
    case "starting":
      return { sentence: "Spade is starting.", ready: false, canTurnOn: false };
    case "off":
      return {
        sentence: status.reason ?? "Spade is off.",
        ready: false,
        canTurnOn: enabled === undefined && !status.reason,
      };
    case "failed":
      return {
        sentence: status.reason ? `Spade stopped. ${status.reason}` : "Spade stopped.",
        ready: false,
        canTurnOn: false,
      };
  }
}

/** Background jobs that wait on ace's agents: a delegation, or a wait for agents already out. */
const agentJobs = new Set(["delegate", "wait"]);

const agentsWord = (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`;

/**
 * The Working line while background jobs run. Agents come first: "Waiting for 2 agents" when
 * every delegation says how many tasks it handed out, else "Waiting for agents"; other jobs
 * by their tool ("Researching in the background", "… and 1 more").
 */
export function spadeJobsLine(jobs: readonly { name: string; agents: number | undefined }[]) {
  const agents = jobs.filter((job) => agentJobs.has(job.name));
  const others = jobs.filter((job) => !agentJobs.has(job.name));
  const background = (list: typeof others) => {
    const words = spadeToolWords(list[0]?.name ?? "").doing;
    return list.length > 1
      ? `${words} and ${list.length - 1} more in the background`
      : `${words} in the background`;
  };
  if (!agents.length) return background(others);
  const delegations = agents.filter((job) => job.name === "delegate");
  const counted = delegations.length > 0 && delegations.every((job) => job.agents !== undefined);
  const total = delegations.reduce((sum, job) => sum + (job.agents ?? 0), 0);
  const waiting = counted ? `Waiting for ${agentsWord(total)}` : "Waiting for agents";
  return others.length
    ? `${waiting}, and ${background(others).replace(/^\w/, (c) => c.toLowerCase())}`
    : waiting;
}

/** The quiet line when a background job ends. */
export function spadeJobEndLine(name: string, outcome: "done" | "failed" | "stopped"): string {
  if (outcome === "stopped") {
    if (name === "delegate") return "Stopped the agents";
    if (name === "wait") return "Stopped waiting for agents";
    const doing = spadeToolWords(name).doing;
    return `Stopped ${doing.charAt(0).toLowerCase()}${doing.slice(1)}`;
  }
  const failed = outcome === "failed";
  if (name === "delegate") return failed ? "The agents' work failed" : "The agents finished";
  if (name === "wait") return failed ? "Couldn't wait for the agents" : "Done waiting for agents";
  const words = spadeToolWords(name);
  return failed ? `Couldn't ${words.base} in the background` : `${words.done} in the background`;
}
