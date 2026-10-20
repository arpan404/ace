import type { Fact, Key } from "@ace/core";
import type { LinkedPullRequest } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, subagent, tool, turn } from "./facts.ts";

/*
 * Threads whose subagents a daemon restart stopped and a coordinator then resumed. A provider
 * that resumes a settled subagent in a new process reports the new run as another agent under
 * the same parent with the same native id; the Summary shows one agent with its latest state.
 */

const restartMessage = "Daemon restarted; previous provider work stopped";
const repo = { forge: "github", host: "github.com", owner: "acme", name: "relay" } as const;
const prUrl = (number: number) => `https://github.com/acme/relay/pull/${number}`;

/** What a subagent runs on, as its provider records it. */
interface RunsOn {
  provider: "claude" | "codex";
  model: string;
}
const opus: RunsOn = { provider: "claude", model: "claude-opus-5-5" };
const codex: RunsOn = { provider: "codex", model: "gpt-5.5" };
/** The thread's own selection: the main agent runs on it. */
const execution = {
  provider: "claude" as const,
  model: "claude-opus-5-5",
  options: { effort: "high" },
};

function spawn(agent: Key, name: string, on: RunsOn = opus): Fact[] {
  return [
    tool("root", `spawn-${agent}`, {
      kind: "agent.spawn",
      title: name,
      detail: { kind: "agent.spawn", description: name, childAgent: agent },
    }),
    subagent(on.provider, agent, name, `spawn-${agent}`, { background: true, model: on.model }),
    turn(agent, "spawn"),
  ];
}

/** The coordinator messages a stopped subagent: the provider starts it again as a new agent. */
function resume(agent: Key, name: string): Fact[] {
  const run = `${agent}-resumed`;
  return [
    tool("root", `message-${agent}`, {
      kind: "agent.message",
      title: `Continue ${name}`,
      detail: { kind: "agent.message", message: "Continue where you stopped." },
    }),
    subagent("claude", run, name, `message-${agent}`, {
      background: true,
      nativeId: agent,
      model: opus.model,
    }),
    turn(run, "parent_agent"),
  ];
}

/** A spawn call that returned: the subagent's result is its first line. */
function reported(call: Key, text: string): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item: call,
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        status: "succeeded",
        result: { isError: false, durationMs: 5, content: [{ type: "text", text }] },
      },
    },
  };
}

const restart: Fact[] = [
  { type: "process.exited", deliberate: false, message: restartMessage },
  { type: "process.started" },
];
/** After the restart the main agent runs a new turn of its own (a new native turn). */
const rootResumed: Fact = {
  type: "turn.started",
  agent: "root",
  nativeTurnId: "root-resumed",
  trigger: "user",
};

/**
 * Two background subagents run; the daemon restarts under them, so both fail; the main agent
 * resumes them, and each finishes. Labels: `spawned`, `restart-failed`, `resumed`, `done`.
 */
export function restartedSubagents(id = "thread-restarted"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "relay",
      title: "Land the relay fixes",
      provider: "claude",
      execution,
      details: {
        repository: repo,
        linkedPrs: [
          {
            number: 302,
            repo,
            url: prUrl(302),
            state: "open",
            title: "Recover stale leases",
            updatedAt: 2,
          },
          {
            number: 301,
            repo,
            url: prUrl(301),
            state: "merged",
            title: "Ack replay order",
            updatedAt: 1,
          },
        ],
      },
    },
    steps: [
      {
        kind: "facts",
        label: "spawned",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", "Fix the relay reconnect bugs, one PR each."),
          ...spawn("ack", "Fix ack buffer replay"),
          ...spawn("lease", "Recover stale leases"),
        ],
      },
      { kind: "facts", delayMs: 400, label: "restart-failed", facts: restart },
      {
        kind: "facts",
        delayMs: 400,
        label: "resumed",
        facts: [
          rootResumed,
          ...resume("ack", "Fix ack buffer replay"),
          ...resume("lease", "Recover stale leases"),
        ],
      },
      {
        kind: "facts",
        delayMs: 600,
        label: "done",
        facts: [
          endTurn("ack-resumed"),
          reported("message-ack", `Fixed the replay order. Opened ${prUrl(301)}`),
          endTurn("lease-resumed"),
          reported("message-lease", `Stale leases recover on startup. Opened ${prUrl(302)}`),
          message("root", "summary", "assistant", "Both fixes are up for review."),
          { type: "turn.ended", agent: "root", nativeTurnId: "root-resumed", outcome: "completed" },
        ],
      },
    ],
  };
}

const finished = [
  "PR panel forge read failures",
  "Auto-open panel setting",
  "Android scrcpy client",
  "PR header and summary",
  "Binary frames and DPR",
  "Fix setForking on main",
  "H.264 video stream",
  "Client video decode",
  "Refs, screenshot, sim CLI",
  "Inventory browser view",
  "Simulator integration",
  "Describe PR panel layout",
  "Browser tool fixes",
  "iOS live browser view",
  "Downloads and file drop",
  "Browser pointer input",
  "Map simulator architecture",
  "Serve-sim passthrough",
  "Browser audio",
];
const resumed = [
  "Page state, pickers, IME",
  "PR timeline invalid data",
  "PR panel remount bug",
  "PR Code tab",
  "PR Timeline tab",
];
const cancelled = [
  "Locate browser stream code",
  "Research serve-sim alternatives",
  "Sim recents and clipboard",
  "Trace replay cursor",
  "Profile frame decode",
  "Audit focus rings",
  "Draft relay ADR",
];

/**
 * A long-running coordinator thread shaped like a real one: 33 subagents (2 working, 5 stopped by
 * a daemon restart then resumed and finished, 7 cancelled, 19 finished), 26 pull requests (24
 * merged, 2 open), and one approval waiting on the person. Labels: `restart-failed`, `resumed`,
 * `settled`.
 */
export function summaryFleet(id = "thread-fleet"): Scenario {
  const prs: LinkedPullRequest[] = [];
  let number = 1040;
  const opened = (merged: boolean, title: string) => {
    number += 1;
    prs.push({
      number,
      repo,
      url: prUrl(number),
      state: merged ? "merged" : "open",
      title,
      updatedAt: 1_000 + number,
    });
    return number;
  };
  const ending: Fact[] = [];
  finished.forEach((name, index) => {
    const agent = `done-${index}`;
    const pr = opened(true, name);
    ending.push(
      endTurn(agent),
      reported(`spawn-${agent}`, `Landed with tests passing. Opened ${prUrl(pr)}`),
    );
  });
  resumed.forEach((name, index) => {
    const agent = `resumed-${index}`;
    const pr = opened(true, name);
    ending.push(
      endTurn(`${agent}-resumed`),
      reported(`message-${agent}`, `Picked up where it stopped; tests pass. Opened ${prUrl(pr)}`),
    );
  });
  cancelled.forEach((_name, index) => ending.push(endTurn(`cancelled-${index}`, "interrupted")));
  const reviewPr = opened(false, "Devices panel redesign");
  const mediaPr = opened(false, "Devices shared media and relay");
  return {
    thread: {
      id,
      workspaceId: "relay",
      title: "Ship the device and browser work",
      provider: "claude",
      execution,
      details: {
        workspace: { id: "relay", name: "relay", path: "/Users/dev/relay" },
        worktree: "/Users/dev/relay",
        mode: "local",
        branch: "main",
        baseBranch: "main",
        repository: repo,
        linkedPrs: prs.toSorted((left, right) => right.updatedAt - left.updatedAt),
      },
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude", "/Users/dev/relay"),
          turn("root"),
          message("root", "ask", "user", "Work through the device and browser issues."),
          ...resumed.flatMap((name, index) => spawn(`resumed-${index}`, name)),
        ],
      },
      { kind: "facts", delayMs: 200, label: "restart-failed", facts: restart },
      {
        kind: "facts",
        delayMs: 200,
        label: "resumed",
        facts: [
          rootResumed,
          ...resumed.flatMap((name, index) => resume(`resumed-${index}`, name)),
          // A mixed fleet: a few of them run on Codex.
          ...finished.flatMap((name, index) =>
            spawn(`done-${index}`, name, index % 6 === 4 ? codex : opus),
          ),
          ...cancelled.flatMap((name, index) => spawn(`cancelled-${index}`, name)),
          ...spawn("devices", "Devices panel redesign"),
          ...spawn("media", "Devices shared media", codex),
        ],
      },
      {
        kind: "facts",
        delayMs: 200,
        label: "settled",
        facts: [
          ...ending,
          tool("devices", "devices-test", {
            kind: "shell",
            title: "Run tests",
            detail: { kind: "shell", command: "bun run test apps/web/src/features/devices" },
          }),
          tool("media", "media-push", {
            kind: "shell",
            title: "Push",
            detail: { kind: "shell", command: `gh pr checks ${mediaPr} --watch` },
          }),
          message(
            "root",
            "progress",
            "assistant",
            `Devices redesign is in review as #${reviewPr}.`,
          ),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "approve-merge",
            blocking: true,
            request: {
              kind: "approval",
              title: `Run gh pr merge ${reviewPr} --squash?`,
              description: "Merges the devices panel redesign into main.",
              options: [
                { id: "allow", label: "Allow once", kind: "allow_once" },
                { id: "deny", label: "Deny", kind: "deny" },
              ],
            },
          },
        ],
      },
    ],
  };
}
