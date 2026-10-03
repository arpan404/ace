import type { Agent, BackgroundTask, ThreadStatus } from "@ace/protocol";

/**
 * "Why isn't this done?" in plain words. ADR 0004: a thread is done only when every agent,
 * subagent, background task, pending question and queued message has settled. This names
 * what is still open and what has to happen for the thread to settle. Pure.
 */
export interface WhyInput {
  status: ThreadStatus;
  rootAgentId: string | undefined;
  agents: readonly Agent[];
  tasks: readonly BackgroundTask[];
  /** Pending interactions that wait for a person. */
  waitingOnYou: number;
}

const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number) => words[n] ?? String(n);
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

const busy = (agent: Agent) =>
  agent.status.state === "working" ||
  agent.status.state === "starting" ||
  (agent.status.state === "blocked" && agent.status.on === "subagents");

export function whyNotDone(input: WhyInput): { title: string; body: string } {
  const { status } = input;
  if (status.state === "done")
    return {
      title: "Done",
      body: "Every agent has finished and nothing is running in the background.",
    };
  if (status.state === "new")
    return { title: "Not started", body: "Nothing has run in this thread yet." };
  if (status.state === "failed") {
    const failed = input.agents.find((agent) => agent.status.state === "failed");
    const name =
      failed && failed.id !== input.rootAgentId ? (failed.name ?? "A subagent") : "The main agent";
    const reason = failed?.status.state === "failed" ? `: ${failed.status.error.message}` : "";
    return { title: "Failed", body: sentence(`${name} failed${reason}`) };
  }

  const open: string[] = [];
  const settles: string[] = [];
  if (input.waitingOnYou > 0) {
    open.push(`${plural(input.waitingOnYou, "question is", "questions are")} waiting for you`);
    settles.push(input.waitingOnYou === 1 ? "you answer it" : "you answer them");
  }
  const root = input.agents.find((agent) => agent.id === input.rootAgentId);
  if (root && (root.status.state === "working" || root.status.state === "starting")) {
    open.push("the main agent is still working");
    settles.push("it finishes its turn");
  }
  const subagents = input.agents.filter((agent) => agent.id !== input.rootAgentId && busy(agent));
  if (subagents.length) {
    open.push(`${plural(subagents.length, "subagent is", "subagents are")} still running`);
    settles.push(
      subagents.length === 1
        ? "it reports back"
        : subagents.length === 2
          ? "both report back"
          : `all ${count(subagents.length)} report back`,
    );
  }
  const running = input.tasks.filter((task) => task.status === "running" && !task.ambient);
  const shells = running.filter((task) => task.kind === "shell");
  const others = running.filter((task) => task.kind !== "shell");
  if (shells.length) {
    open.push(`${plural(shells.length, "background shell is", "background shells are")} open`);
    settles.push(
      shells.length === 1 ? "the shell is stopped or finishes" : "the shells are stopped or finish",
    );
  }
  if (others.length) {
    open.push(`${plural(others.length, "background task is", "background tasks are")} running`);
    settles.push(others.length === 1 ? "that task ends" : "those tasks end");
  }
  const lost = input.tasks.filter((task) => task.status === "unknown" && !task.ambient);
  if (lost.length)
    open.push(
      `ace lost track of ${plural(lost.length, "background task", "background tasks")}, which may still be running`,
    );
  for (const agent of input.agents) {
    if (agent.status.state !== "blocked") continue;
    const name = agent.id === input.rootAgentId ? "the main agent" : (agent.name ?? "a subagent");
    if (agent.status.on === "rate_limit") {
      open.push(`${name} is rate limited by its provider`);
      settles.push("the limit resets");
    } else if (agent.status.on === "network") {
      open.push(`${name} is waiting for the network`);
      settles.push("the connection comes back");
    } else if (agent.status.on === "upstream") {
      open.push(`${name}'s provider is overloaded and retrying`);
      settles.push("the provider recovers");
    }
  }
  if (status.state === "waiting" && status.on === "queue") {
    open.push("a queued message has not been sent yet");
    settles.push("the queued message has been handled");
  }
  const quiet = input.agents.filter((agent) => agent.status.state === "unresponsive");
  if (quiet.length)
    open.push(`${plural(quiet.length, "agent has", "agents have")} stopped sending anything`);
  if (!open.length)
    return { title: "Why isn't this done?", body: "The daemon is still settling this thread." };
  const body = [sentence(list(open))];
  if (settles.length) body.push(sentence(`The thread settles when ${list(settles)}`));
  return { title: "Why isn't this done?", body: body.join(" ") };
}
