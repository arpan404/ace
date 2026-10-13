import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, turn } from "./facts.ts";

const cwd = "/Users/dev/sites";
export const delegatedQuestionIds = {
  parent: "thread-site-review",
  child: "thread-site-review-codex",
} as const;

/** The delegated child's status as its parent's summary agent follows it. */
export function childStatus(status: import("@ace/protocol").ThreadStatus): Fact {
  return {
    type: "agent.external",
    agent: "reviewer",
    threadId: ThreadId.parse(delegatedQuestionIds.child),
    status,
  };
}

/**
 * A Claude thread that delegated a site review to Codex through ace. The Codex child stopped to
 * ask the person which pages count, so the whole tree waits on a question that lives in the
 * child's thread: the parent's strip shows it, labelled with the child's name, and answers it
 * there. Play `delegatedQuestion()` whole: the parent first, then the child.
 */
export function delegatedQuestion(): Scenario[] {
  const child: Scenario = {
    thread: {
      id: delegatedQuestionIds.child,
      workspaceId: "relay",
      title: "Review the marketing pages",
      provider: "codex",
      parentThreadId: delegatedQuestionIds.parent,
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          message("root", "ask", "user", "Review every marketing page for broken layouts."),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "pages",
            blocking: true,
            request: {
              kind: "question",
              questions: [
                {
                  id: "scope",
                  text: "Should the review include the archived blog posts?",
                  multiSelect: false,
                  allowOther: false,
                  options: [
                    { id: "yes", label: "Include them" },
                    { id: "no", label: "Skip the archive" },
                  ],
                },
              ],
            },
          },
        ],
      },
      { kind: "await", interaction: "pages" },
    ],
  };
  const parent: Scenario = {
    thread: {
      id: delegatedQuestionIds.parent,
      workspaceId: "relay",
      title: "Site review",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Have Codex review the marketing pages."),
          tool("root", "delegate-review", {
            kind: "agent.spawn",
            title: "Delegate the page review to Codex",
            detail: {
              kind: "agent.spawn",
              description: "Review every marketing page for broken layouts",
              prompt: "Review every marketing page for broken layouts.",
              agentType: "codex",
              childAgent: "reviewer",
            },
          }),
          {
            type: "agent.seen",
            agent: "reviewer",
            parent: "root",
            spawnedBy: "delegate-review",
            origin: "ace",
            fidelity: "full",
            native: { provider: "codex", nativeId: "reviewer" },
            cwd,
            name: "general assistant",
          },
          childStatus({ state: "needs_you", interactions: 1 }),
          message(
            "root",
            "handoff",
            "assistant",
            "Codex is reviewing the pages in its own thread and has a question for you.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
  return [parent, child];
}
