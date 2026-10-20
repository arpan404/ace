import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { z } from "zod";

/*
 * Threads that wait on the person, for the spike daemon: an approval, a question, a plan review,
 * an MCP form, and a turn to stop. Each is seeded once under its fixed id for the app and UI
 * tests, and `/review/fresh` seeds another under a new id, so a contract test that answers one
 * never changes what another test (in any order) finds. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
export const RequestScenario = z.enum(["approval", "question", "plan", "form", "stop"]);
export type RequestScenario = z.infer<typeof RequestScenario>;

/** A model the fixture's catalog lists with effort levels and fast tiers (`workbenchServices`). */
const tunable = {
  provider: "codex" as const,
  model: "simulated-ultra-reasoning-extended-context-demonstration-model",
  instanceId: "codex-personal",
  options: {},
};

const seeds: Record<RequestScenario, (daemon: FakeDaemon, id: string, details: Details) => void> = {
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
}
