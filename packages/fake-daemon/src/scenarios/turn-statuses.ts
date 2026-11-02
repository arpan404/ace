import { ultraReasoningPreview } from "./ultra-reasoning.ts";
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

/** The first two subagents a waiting root starts; any more are numbered. */
const auditors = [
  ["web", "web-audit", "Audit the web client", "apps/web/src/resume.ts"],
  ["mobile", "mobile-audit", "Audit the mobile client", "apps/mobile/src/resume.ts"],
] as const;

/** A root agent waiting on the subagents it started: two unless `count` says otherwise. */
export function waitingOnSubagents(
  id = "thread-waiting-subagents",
  count = 2,
  title = "Audit resume paths",
): Scenario {
  const children = Array.from({ length: count }, (_, index) => {
    const known = auditors[index];
    const n = index + 1;
    return known ?? ([`audit-${n}`, `audit-${n}`, `Audit part ${n}`, `src/part-${n}.ts`] as const);
  });
  return {
    thread: { id, workspaceId: "relay", title, provider: "claude" },
    steps: [
      {
        kind: "facts",
        label: "waiting",
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Audit every resume path, in parallel."),
          ...children.flatMap(([child, name, description, file]): Fact[] => [
            ...spawn(`spawn-${child}`, child, name, description),
            { type: "activity", agent: child, activity: "tool", detail: `Reading ${file}` },
          ]),
          {
            type: "subagents.waiting",
            agent: "root",
            item: `spawn-${children.at(-1)?.[0] ?? "web"}`,
            targets: [],
          },
        ],
      },
    ],
  };
}

/** A turn that failed just now, so its row reads as a fresh failure. */
export function failedJustNow(id = "thread-failed-now"): Scenario {
  return {
    thread: { id, workspaceId: "relay", title: "Rebuild the relay index", provider: "codex" },
    steps: [
      {
        kind: "facts",
        label: "failed",
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          message("root", "ask", "user", "Rebuild the relay index."),
          endTurn("root", "failed", { kind: "provider", message: "The index file is locked." }),
        ],
      },
    ],
  };
}

/**
 * Thread-row statuses the dev world lacks, beside its requests, model and finished work:
 * waiting on three agents, a background command, a test run. A fresh failure
 * (`failedJustNow`) must be played after the client's first launch to read as news.
 */
export function rowStates(): Scenario[] {
  return [
    waitingOnSubagents("thread-waiting-three", 3, "Audit the three resume paths"),
    watchingRelay(),
    runningTests(),
  ];
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
                  secret: false,
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
  return [
    oneTurnWork(),
    watchingRelay(),
    waitingOnSubagents(),
    runningTests(),
    askingQuestion(),
    ultraReasoningPreview(),
  ];
}
