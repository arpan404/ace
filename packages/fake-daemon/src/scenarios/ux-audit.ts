import type { Scenario } from "../scenario.ts";
import { endTurn, message, tool, toolDone, turn } from "./facts.ts";
import { cwd, input, scenario, command } from "./ux-facts.ts";
import { question, delegation } from "./ux-interactions.ts";
const root = "root";
/** Recorded provider shapes, exercised without starting any provider or reading host files. */
export function uxAudit(): Scenario[] {
  const switchScenario = scenario(
    "switch-handoff",
    "A provider switch continues from a summary",
    [
      message(root, "before", "assistant", "The login redirect is fixed. I'll hand off the tests."),
      endTurn(root),
      input(
        "summary",
        JSON.stringify({ summary: "Login redirect fixed. Verify the session tests." }),
        {
          kind: "handoff",
          from: { provider: "claude", model: "opus-4.1" },
          to: { provider: "codex", model: "gpt-5.5" },
          lossy: true,
        },
      ),
      turn(root),
      input("followup", "Verify the session tests.", { kind: "person" }),
      ...command("verify", "bun run test src/login.test.ts"),
      message(root, "after", "assistant", "The session tests pass."),
    ],
    { provider: "claude" },
  );
  const pendingPermission = scenario(
    "pending-full-access",
    "Approval while Full access is pending",
    [
      tool(root, "install", {
        kind: "shell",
        title: "Run bun install --frozen-lockfile",
        status: "awaiting_approval",
        detail: {
          kind: "shell",
          command: "bun install --frozen-lockfile",
          rawCommand: "/bin/zsh -lc 'bun install --frozen-lockfile'",
        },
      }),
      {
        type: "interaction.opened",
        agent: root,
        interaction: "approval",
        item: "install",
        blocking: true,
        request: {
          kind: "approval",
          title: "Run bun install --frozen-lockfile?",
          description: "Package installation needs network access.",
          target: {
            tool: "item/commandExecution/requestApproval",
            command: "/bin/zsh -lc 'bun install --frozen-lockfile'",
            cwd,
            access: "execute",
          },
          options: [
            { id: "allow", kind: "allow_once", label: "Allow once" },
            { id: "deny", kind: "deny", label: "Deny" },
          ],
        },
      },
    ],
    { pending: true },
  );
  pendingPermission.steps.push({
    kind: "update",
    changes: {
      permission: {
        override: "full-access",
        effective: "auto-review",
        pending: true,
      },
    },
  });
  switchScenario.steps.push({
    kind: "update",
    changes: {
      provider: "codex",
      switch: {
        selection: { provider: "codex", model: "gpt-5.5", options: {} },
        state: "applied",
        lossy: true,
        at: 1,
      },
    },
  });
  return [
    question(false),
    question(true),
    scenario(
      "wrapped-commands",
      "Codex wraps a command in a login shell",
      command("read", "cat src/math.ts"),
    ),
    scenario(
      "absolute-paths",
      "Read absolute paths in two worktrees",
      [
        `${cwd}/apps/web/src/app.tsx`,
        "/Users/dev/.ace-next/worktrees/ace/other/src/math.ts",
        "/Users/dev/notes/todo.md",
      ].flatMap((path, i) => [
        tool(root, `read-${i}`, {
          kind: "file.read",
          title: `Read ${path}`,
          detail: { kind: "file.read", path },
        }),
        toolDone(root, `read-${i}`),
      ]),
    ),
    scenario("skill-reads", "Load a skill from an absolute home path", [
      tool(root, "skill", {
        kind: "file.read",
        title: "Read SKILL.md",
        detail: { kind: "file.read", path: "/Users/dev/.agents/skills/diagnosing-bugs/SKILL.md" },
      }),
      toolDone(root, "skill"),
    ]),
    switchScenario,
    ...delegation(),
    scenario(
      "interrupted",
      "Stop keeps partial assistant text",
      [
        message(
          root,
          "partial",
          "assistant",
          "I found the redirect loop in the session middleware.",
        ),
        endTurn(root, "interrupted"),
      ],
      { pending: true },
    ),
    scenario(
      "auth-error",
      "A failed turn needs Claude Code sign-in",
      [
        {
          type: "item.upsert",
          agent: root,
          item: "auth",
          draft: {
            type: "notice",
            complete: true,
            level: "error",
            code: "auth",
            title: "Not signed in to Claude Code",
            text: "Sign in to Claude Code and retry.",
            detail: "CLI authentication is missing.",
          },
        },
        endTurn(root, "failed", {
          kind: "auth",
          code: "auth",
          title: "Not signed in to Claude Code",
          message: "Sign in to Claude Code and retry.",
        }),
      ],
      { provider: "claude", pending: true },
    ),
    pendingPermission,
    scenario("restart-continuation", "ace restarts and continues interrupted work", [
      ...command("before-restart", "pwd"),
      endTurn(root, "interrupted"),
      turn(root, "restart"),
      input("continuation", "Continue the interrupted work. The previous shell process died.", {
        kind: "restart",
      }),
      message(
        root,
        "after-restart",
        "assistant",
        "I resumed from the saved thread and reran the checks.",
      ),
    ]),
    scenario("failed-commands", "Several commands fail before a successful retry", [
      ...command("test-1", "bun run test src/login.test.ts", "failed"),
      ...command("test-2", "bun run test src/login.test.ts", "failed"),
      ...command("lint", "bun run lint", "failed"),
      ...command("test-3", "bun run test src/login.test.ts"),
      message(root, "fixed", "assistant", "The test now passes. Lint still needs a fix."),
    ]),
    scenario(
      "changed-files-mid-turn",
      "Edits continue after a progress message",
      [
        tool(root, "edit", {
          kind: "file.edit",
          title: "Edit src/login.ts",
          detail: {
            kind: "file.edit",
            changes: [
              {
                path: `${cwd}/src/login.ts`,
                kind: "update",
                diff: "@@ -1 +1,2 @@\n-old\n+fixed\n+checked",
              },
            ],
          },
        }),
        toolDone(root, "edit"),
        message(
          root,
          "progress",
          "assistant",
          "The redirect fix is in place. I'm checking the session tests.",
        ),
        tool(root, "test", {
          kind: "shell",
          title: "Run session tests",
          detail: { kind: "shell", command: "bun run test src/login.test.ts" },
        }),
      ],
      { pending: true },
    ),
  ];
}

/** Every entry has a stable route for the UI screenshot runner. */
export const uxAuditScreens = uxAudit().map((entry) => ({
  id: entry.thread.id,
  title: entry.thread.title,
  path: `/t/${entry.thread.id}`,
}));
