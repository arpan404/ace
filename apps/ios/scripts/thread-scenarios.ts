import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";

/*
 * Thread-screen fixtures for the spike daemon: a finished turn that folds into "Worked for",
 * a running turn with native and ace-delegated subagents, and a question card. Facts are dated
 * in the past so durations read like real work. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
const minute = 60_000;

const read = (item: string, path: string): Fact[] => [
  facts.tool("root", item, {
    kind: "file.read",
    title: `Read ${path}`,
    detail: { kind: "file.read", path },
  }),
  facts.toolDone("root", item),
];

export function threadScenarios(daemon: FakeDaemon, details: Details): void {
  daemon.createThread(
    {
      id: "ios-agents",
      workspaceId: "ace",
      title: "Add ace stop and a safe kill-all",
      provider: "codex",
      details: details("feat/ace-stop"),
      live: { model: "gpt-6.1 · high", subagentCount: 3, backgroundTaskCount: 0 },
    },
    30 * minute,
  );
  daemon.apply(
    "ios-agents",
    [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message(
        "root",
        "ask",
        "user",
        "Add `ace stop` and a safe kill-all. Never kill a process we don't own.",
      ),
    ],
    28 * minute,
  );
  daemon.apply(
    "ios-agents",
    [
      ...read("read-owner", "packages/daemon/src/process-owner.ts"),
      ...read("read-kill", "packages/daemon/src/kill.ts"),
      facts.tool("root", "search", {
        kind: "search",
        title: "Search for spawn(",
        detail: { kind: "search", query: "spawn(", path: "packages", matches: 14 },
      }),
      facts.toolDone("root", "search"),
      facts.message(
        "root",
        "plan",
        "assistant",
        "Process groups are recorded at spawn. I'll key ownership on the kernel start time too.",
      ),
    ],
    24 * minute,
  );
  daemon.apply(
    "ios-agents",
    [
      facts.tool("root", "edit", {
        kind: "file.edit",
        title: "Edit process-owner.ts",
        detail: {
          kind: "file.edit",
          changes: [
            {
              path: "packages/daemon/src/process-owner.ts",
              kind: "update",
              diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+owner",
            },
          ],
        },
      }),
      facts.toolDone("root", "edit"),
      facts.tool("root", "test", {
        kind: "shell",
        title: "Run tests",
        detail: { kind: "shell", command: "bun run test packages/daemon" },
      }),
      facts.toolDone("root", "test"),
      facts.message(
        "root",
        "answer",
        "assistant",
        [
          "Orphan cleanup now records each child's **kernel start time** and owner, so a reused PID is never killed.",
          "",
          "- `ace stop` interrupts the whole tree",
          "- `ace stop --all` only touches processes we started",
          "",
          "```ts",
          "if (owner.startedAt !== kernel.startedAt) return skip(pid);",
          "```",
        ].join("\n"),
      ),
      facts.endTurn("root"),
    ],
    14 * minute,
  );
  daemon.createThread(
    {
      id: "ios-agents-review",
      workspaceId: "ace",
      title: "Review PID-reuse safety",
      provider: "claude",
      details: details("feat/ace-stop"),
      parentThreadId: "ios-agents",
    },
    6 * minute,
  );
  daemon.apply(
    "ios-agents-review",
    [
      facts.rootAgent("claude"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Review the kill-all change for PID-reuse safety."),
      ...read("read", "packages/daemon/src/process-owner.ts"),
      facts.message("root", "note", "assistant", "Checking how start times are compared.", false),
    ],
    5 * minute,
  );
  daemon.apply(
    "ios-agents",
    [
      { type: "turn.started", agent: "root", nativeTurnId: "root-turn-2", trigger: "user" },
      facts.message("root", "ask-2", "user", "Now wire kill-all filters by thread and project."),
      facts.message("root", "split", "assistant", "I'll split this across three agents."),
      facts.tool("root", "spawn-explore", {
        kind: "agent.spawn",
        title: "Explore process groups",
        detail: {
          kind: "agent.spawn",
          description: "Explore process groups",
          childAgent: "explore",
        },
      }),
      facts.subagent("codex", "explore", "Explore process groups", "spawn-explore"),
      facts.turn("explore", "spawn"),
      facts.message("explore", "found", "assistant", "Process groups are created per thread."),
      facts.endTurn("explore"),
      facts.toolDone("root", "spawn-explore"),
      facts.tool("root", "spawn-tests", {
        kind: "agent.spawn",
        title: "Write orphan-cleanup tests",
        detail: {
          kind: "agent.spawn",
          description: "Write orphan-cleanup tests",
          childAgent: "tests",
        },
      }),
      facts.subagent("codex", "tests", "Write orphan-cleanup tests", "spawn-tests"),
      facts.turn("tests", "spawn"),
      facts.message("tests", "writing", "assistant", "Writing the PID-reuse regression.", false),
      facts.tool("root", "spawn-review", {
        kind: "agent.spawn",
        title: "Review PID-reuse safety",
        detail: {
          kind: "agent.spawn",
          description: "Review PID-reuse safety",
          childAgent: "review",
        },
      }),
      {
        type: "agent.seen",
        agent: "review",
        parent: "root",
        spawnedBy: "spawn-review",
        origin: "ace",
        fidelity: "full",
        native: { provider: "claude", nativeId: "review" },
        cwd: "/Users/dev/acme",
        name: "Review PID-reuse safety",
      },
      {
        type: "agent.external",
        agent: "review",
        threadId: ThreadId.parse("ios-agents-review"),
        status: { state: "working", agents: 1 },
      },
      facts.message(
        "root",
        "wiring",
        "assistant",
        "Wiring the filters while the agents work",
        false,
      ),
    ],
    3 * minute,
  );

  daemon.createThread({
    id: "ios-stop",
    workspaceId: "ace",
    title: "Profile the slow startup",
    provider: "codex",
    details: details("perf/startup"),
  });
  daemon.apply("ios-stop", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Profile the slow startup."),
    facts.tool("root", "profile", {
      kind: "shell",
      title: "Profile startup",
      detail: { kind: "shell", command: "bun run profile:startup" },
    }),
  ]);

  daemon.createThread({
    id: "ios-question",
    workspaceId: "ace",
    title: "Clean up the release notes",
    provider: "claude",
    details: details("docs/release"),
  });
  daemon.apply("ios-question", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Tidy the release notes before the tag."),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "scope",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "archive",
            header: "Scope",
            text: "Should the notes include the archived 0.x entries?",
            multiSelect: false,
            allowOther: true,
            options: [
              {
                id: "skip",
                label: "Skip the archive (Recommended)",
                description: "Only 1.0 and later",
              },
              { id: "keep", label: "Keep everything" },
            ],
          },
        ],
      },
    },
  ]);
}
