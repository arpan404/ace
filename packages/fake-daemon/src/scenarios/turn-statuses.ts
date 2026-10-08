import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, subagent, tool, toolDone, turn } from "./facts.ts";

/*
 * Threads that show what a thread is doing: one OpenCode turn that talks between its steps,
 * leaves a background task behind and starts a subagent (one "Worked for"), and threads caught
 * watching a background command, waiting on subagents, running tests and asking the person.
 */

const cwd = "/Users/dev/relay";

function read(agent: string, key: string, path: string): Fact[] {
  return [
    tool(agent, key, {
      kind: "file.read",
      title: `Read ${path}`,
      detail: { kind: "file.read", path },
    }),
    toolDone(agent, key),
  ];
}

function shell(agent: string, key: string, command: string, done = true): Fact[] {
  return [
    tool(agent, key, { kind: "shell", title: command, detail: { kind: "shell", command } }),
    ...(done ? [toolDone(agent, key)] : []),
  ];
}

function spawn(key: string, child: string, name: string, description: string): Fact[] {
  return [
    tool("root", key, {
      kind: "agent.spawn",
      title: description,
      detail: { kind: "agent.spawn", description, childAgent: child },
    }),
    subagent("opencode", child, name, key),
    turn(child, "spawn"),
  ];
}

/**
 * The case the owner reported: one OpenCode turn that reads, says what it found, runs a
 * background task to its end, starts a subagent and works on before answering. Labels:
 * `interim`, `background-done`, `answered`.
 */
export function oneTurnWork(id = "thread-one-turn"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "relay",
      title: "Find why resume drops events",
      provider: "opencode",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("opencode", cwd),
          turn("root"),
          message("root", "ask", "user", "Find why resume drops events after a restart."),
          ...read("root", "read-session", "src/session.ts"),
          ...read("root", "read-outbox", "src/outbox.ts"),
        ],
      },
      {
        kind: "facts",
        delayMs: 400,
        label: "interim",
        facts: [
          message(
            "root",
            "interim",
            "assistant",
            "The outbox clears its buffer before the daemon acknowledges the resume. Checking the replay path next.",
          ),
          tool("root", "background-work", {
            kind: "custom",
            title: "Check the replay path",
            detail: { kind: "custom" },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "background-work",
            kind: "other",
            title: "OpenCode background work",
            item: "background-work",
            stoppable: false,
          },
        ],
      },
      {
        kind: "facts",
        delayMs: 400,
        label: "background-done",
        facts: [
          { type: "background.ended", task: "background-work", status: "completed" },
          toolDone("root", "background-work"),
          ...spawn("spawn-audit", "audit", "resume-audit", "Audit the other resume paths"),
          ...read("audit", "audit-read", "apps/mobile/src/resume.ts"),
          endTurn("audit"),
          toolDone("root", "spawn-audit"),
          ...read("root", "read-replay", "src/replay.ts"),
          ...shell("root", "test-replay", "bun run test replay"),
        ],
      },
      {
        kind: "facts",
        delayMs: 400,
        label: "answered",
        facts: [
          message(
            "root",
            "answer",
            "assistant",
            "Resume dropped events because the outbox cleared its buffer before the ack. It now keeps the buffer until `resume.ack` and flushes in order; the replay tests pass.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}

/**
 * A turn that built the app in the background (that finished) and left the dev relay running:
 * the thread watches the relay.
 */
export function watchingRelay(id = "thread-watching-relay"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "relay",
      title: "Run the relay for the mobile test",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        label: "watching",
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Start the relay so I can test the mobile app."),
          ...shell("root", "build", "bun run build", false),
          {
            type: "background.started",
            agent: "root",
            task: "build",
            kind: "shell",
            title: "bun run build",
            item: "build",
            stoppable: true,
          },
          { type: "background.ended", task: "build", status: "completed" },
          toolDone("root", "build"),
          ...shell("root", "relay", "bun run dev:relay", false),
          {
            type: "background.started",
            agent: "root",
            task: "relay",
            kind: "shell",
            title: "bun run dev:relay",
            item: "relay",
            stoppable: true,
          },
          message("root", "answer", "assistant", "The relay is listening on ws://127.0.0.1:8787."),
          endTurn("root"),
        ],
      },
    ],
  };
}

/** A root agent waiting on the two subagents it started. */
export function waitingOnSubagents(id = "thread-waiting-subagents"): Scenario {
  return {
    thread: { id, workspaceId: "relay", title: "Audit resume paths", provider: "claude" },
    steps: [
      {
        kind: "facts",
        label: "waiting",
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Audit every resume path, in parallel."),
          ...spawn("spawn-web", "web", "web-audit", "Audit the web client"),
          {
            type: "activity",
            agent: "web",
            activity: "tool",
            detail: "Reading apps/web/src/resume.ts",
          },
          ...spawn("spawn-mobile", "mobile", "mobile-audit", "Audit the mobile client"),
          {
            type: "activity",
            agent: "mobile",
            activity: "tool",
            detail: "Reading apps/mobile/src/resume.ts",
          },
          { type: "subagents.waiting", agent: "root", item: "spawn-mobile", targets: [] },
        ],
      },
    ],
  };
}

/** A root agent in the middle of a test run. */
export function runningTests(id = "thread-running-tests"): Scenario {
  return {
    thread: { id, workspaceId: "relay", title: "Fix the flaky replay test", provider: "codex" },
    steps: [
      {
        kind: "facts",
        label: "testing",
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          message("root", "ask", "user", "Fix the flaky replay test."),
          ...read("root", "read-test", "src/replay.test.ts"),
          ...shell("root", "vitest", "bun run test src/replay.test.ts", false),
        ],
      },
    ],
  };
}

/** A root agent that asked the person which way to go. */
export function askingQuestion(id = "thread-asking"): Scenario {
  return {
    thread: { id, workspaceId: "relay", title: "Cap cold-start replay", provider: "cursor" },
    steps: [
      {
        kind: "facts",
        label: "asked",
        facts: [
          rootAgent("cursor", cwd),
          turn("root"),
          message("root", "ask", "user", "Cap cold-start replay."),
          ...read("root", "read-replay", "src/replay.ts"),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "ask-cap",
            blocking: true,
            request: {
              kind: "question",
              questions: [
                {
                  id: "cap",
                  text: "How many events should a cold start replay?",
                  multiSelect: false,
                  allowOther: true,
                  options: [
                    { id: "200", label: "The last 200" },
                    { id: "1000", label: "The last 1,000" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Every thread above, as the fake world `thread-activity` seeds them. */
export function turnStatuses(): Scenario[] {
  return [oneTurnWork(), watchingRelay(), waitingOnSubagents(), runningTests(), askingQuestion()];
}
