import { InteractionRequest } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { z } from "zod";

/*
 * Threads that wait on the person, for the spike daemon: an approval, a question, a plan review,
 * an MCP form, and a turn to stop. Each is seeded once under its fixed id for the app and UI
 * tests, and `/review/fresh` seeds another under a new id, so a contract test that answers one
 * never changes what another test (in any order) finds. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
export const RequestScenario = z.enum([
  "approval",
  "question",
  "plan",
  "form",
  "stop",
  "browserHelp",
  "summarized",
]);
export type RequestScenario = z.infer<typeof RequestScenario>;

/** A model the fixture's catalog lists with effort levels and fast tiers (`workbenchServices`). */
const tunable = {
  provider: "codex" as const,
  model: "simulated-ultra-reasoning-extended-context-demonstration-model",
  instanceId: "codex-personal",
  options: {},
};

/** A sign-in the agent hands to the person in the browser. */
const signIn = (key: string, tabId: string, url: string) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction: key,
  blocking: true,
  request: InteractionRequest.parse({
    kind: "browser_help",
    tabId,
    reason: "login",
    message: "Sign in with the team account",
    url,
  }),
});

const shardManifest = [
  "Rebuilds the v14 workspace shard index across 64 local partitions and verifies row checksums before swapping the active pointer.",
  "",
  ...Array.from({ length: 900 }, (_, index) => {
    const shard = String(index + 1).padStart(3, "0");
    return `Partition ${shard} · workspace_events_${shard} · 14,820 rows · checksum sha256:9f86d081884c7d659a2feaa0c55ad015`;
  }),
].join("\n");

const seeds: Record<RequestScenario, (daemon: FakeDaemon, id: string, details: Details) => void> = {
  summarized(daemon, id, details) {
    daemon.createThread({
      hasSentMessage: true,
      id,
      workspaceId: "ace",
      title: "Migrate workspace schema to v14",
      provider: "claude",
      details: details("feat/schema-v14"),
      access: "ask",
    });
    daemon.apply(id, [
      facts.rootAgent("claude"),
      facts.turn("root"),
      facts.message(
        "root",
        "ask",
        "user",
        "Run the v14 workspace migration and verify every partition checksum.",
      ),
      facts.message(
        "root",
        "answer",
        "assistant",
        "The migration script is ready. It rebuilds the shard index and verifies all local workspace partitions before swapping the active pointer.",
      ),
      facts.tool("root", "migrate", {
        kind: "shell",
        title: "Claude Code wants to run a command",
        status: "awaiting_approval",
        detail: {
          kind: "shell",
          command: "bun scripts/migrate-v14.ts --verify-shards --apply",
        },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "migrate",
        item: "migrate",
        blocking: true,
        request: {
          kind: "approval",
          title: "Claude Code wants to run a command",
          description: shardManifest,
          target: {
            tool: "Bash",
            command: "bun scripts/migrate-v14.ts --verify-shards --apply",
            access: "execute",
          },
          options: [
            { id: "deny", label: "Deny", kind: "deny" },
            { id: "always", label: "Always allow", kind: "allow_always" },
            { id: "allow", label: "Allow once", kind: "allow_once" },
          ],
        },
      },
    ]);
  },
  approval(daemon, id, details) {
    daemon.createThread({
      hasSentMessage: true,
      id,
      workspaceId: "ace",
      title: "Fix the flaky queue test",
      provider: "codex",
      details: details("fix/queue"),
      access: "ask",
    });
    daemon.apply(id, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Fix the flaky queue test, then push the branch."),
      facts.tool("root", "edit", {
        kind: "file.read",
        title: "Read queue.test.ts",
        detail: { kind: "file.read", path: "queue.test.ts" },
      }),
      facts.toolDone("root", "edit"),
      facts.message(
        "root",
        "answer",
        "assistant",
        "The retry timer used wall-clock time, so a slow CI box could fire it twice. The test now pins the injected clock. All 214 tests pass.",
      ),
      facts.tool("root", "push", {
        kind: "shell",
        title: "Codex wants to run a command",
        status: "awaiting_approval",
        detail: { kind: "shell", command: "git push origin fix/queue" },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "push",
        item: "push",
        blocking: true,
        request: {
          kind: "approval",
          title: "Codex wants to run a command",
          description: "Publishes 2 commits to GitHub",
          // As the Codex adapter names it, so lists show the command without the transcript.
          target: { tool: "shell", command: "git push origin fix/queue", access: "execute" },
          options: [
            { id: "deny", label: "Deny", kind: "deny" },
            { id: "always", label: "Always here", kind: "allow_session" },
            { id: "allow", label: "Allow", kind: "allow_once" },
          ],
        },
      },
    ]);
  },
  question(daemon, id, details) {
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: "Clean up the release notes",
      provider: "claude",
      details: details("docs/release"),
    });
    daemon.apply(id, [
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
              secret: false,
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
  },
  plan(daemon, id, details) {
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: "Plan the kill-all filters",
      provider: "codex",
      details: details("feat/kill-filters"),
      execution: tunable,
    });
    daemon.apply(id, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Plan kill-all filters by thread and project."),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "plan",
        blocking: true,
        request: {
          kind: "plan_review",
          title: "Kill-all filters",
          summary: "Filter by thread or project, never touch processes ace didn't start.",
          markdown: [
            "## Steps",
            "",
            "1. Record each child's **kernel start time** at spawn",
            "2. Add `--thread` and `--project` filters to `ace stop --all`",
            "3. Skip any PID whose start time no longer matches",
            "",
            "Tests cover PID reuse and a process started outside ace.",
          ].join("\n"),
          todos: [
            { content: "Record start times", status: "completed" },
            { content: "Add the filters", status: "pending" },
            { content: "PID-reuse tests", status: "pending" },
          ],
        },
      },
    ]);
  },
  form(daemon, id, details) {
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: "Deploy the preview",
      provider: "claude",
      details: details("deploy/preview"),
    });
    daemon.apply(id, [
      facts.rootAgent("claude"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Deploy the preview build."),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "deploy",
        blocking: true,
        request: {
          kind: "elicitation",
          server: "deploy",
          message: "Where should the preview deploy?",
          mode: "form",
          schema: {
            type: "object",
            properties: {
              region: {
                type: "string",
                title: "Region",
                enum: ["eu-west", "us-east"],
                enumNames: ["EU West", "US East"],
              },
              replicas: {
                type: "integer",
                title: "Replicas",
                description: "Between 1 and 5",
                minimum: 1,
                maximum: 5,
              },
              note: { type: "string", title: "Release note", maxLength: 120 },
            },
            required: ["region", "replicas"],
          },
        },
      },
    ]);
  },
  /** Two sign-ins the agent hands to the person, so a test can open the second one's browser. */
  browserHelp(daemon, id, details) {
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: "Sign in to both forges",
      provider: "claude",
      details: details("chore/forges"),
    });
    daemon.apply(id, [
      facts.rootAgent("claude"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Sign in to GitHub and GitLab."),
      signIn("help-github", "tab-1", "https://github.com/login"),
      signIn("help-gitlab", "tab-2", "https://gitlab.com/users/sign_in"),
    ]);
  },
  stop(daemon, id, details) {
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: "Profile the slow startup",
      provider: "codex",
      details: details("perf/startup"),
    });
    daemon.apply(id, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Profile the slow startup."),
      facts.tool("root", "profile", {
        kind: "shell",
        title: "Profile startup",
        detail: { kind: "shell", command: "bun run profile:startup" },
      }),
    ]);
  },
};

export function seedRequest(
  daemon: FakeDaemon,
  scenario: RequestScenario,
  id: string,
  details: Details,
): void {
  seeds[scenario](daemon, id, details);
}

/** The fixed threads the app and its UI tests open by name. */
export function requestScenarios(daemon: FakeDaemon, details: Details): void {
  seedRequest(daemon, "approval", "ios-approval", details);
  seedRequest(daemon, "question", "ios-question", details);
  seedRequest(daemon, "plan", "ios-plan", details);
  seedRequest(daemon, "form", "ios-form", details);
  seedRequest(daemon, "stop", "ios-stop", details);
  threeAsks(daemon, details);
}

/** One approval the agent asks for, with Deny, Always and Allow. */
const ask = (key: string, title: string, target: Record<string, unknown>) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction: key,
  blocking: true,
  request: InteractionRequest.parse({
    kind: "approval",
    title,
    target: { tool: "Bash", access: "execute", ...target },
    options: [
      { id: "deny", label: "Deny", kind: "deny" },
      { id: "always", label: "Always", kind: "allow_session" },
      { id: "allow", label: "Allow", kind: "allow_once" },
    ],
  }),
});

/** An approval arriving in a thread already open, as an agent asks for one mid-turn. */
export function askLater(daemon: FakeDaemon, threadId: string): void {
  daemon.apply(threadId, [ask("late", "Run bun run lint", { command: "bun run lint" })]);
}

/** ios-three-asks: three approvals waiting at once, so the strip pages them ("1 of 3"). */
function threeAsks(daemon: FakeDaemon, details: Details): void {
  const id = "ios-three-asks";
  daemon.createThread({
    hasSentMessage: true,
    id,
    workspaceId: "ace",
    title: "Ship the relay fix",
    provider: "claude",
    details: details("fix/relay-ship"),
    access: "ask",
  });
  daemon.apply(id, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Ship the relay fix: test, edit the changelog, push."),
    ask("test", "Run bun run test --filter relay", { command: "bun run test --filter relay" }),
    ask("notes", "Edit CHANGELOG.md", {
      tool: "Edit",
      access: "write",
      paths: ["/Users/dev/acme/packages/relay/CHANGELOG.md"],
    }),
    ask("push", "Run git push origin fix/relay-ship", {
      command: "git push origin fix/relay-ship",
    }),
  ]);
}
