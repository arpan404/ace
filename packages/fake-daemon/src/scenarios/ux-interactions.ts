import type { Fact } from "@ace/core";
import { InteractionId, ThreadId } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, tool, toolDone } from "./facts.ts";
import { cwd, input, scenario } from "./ux-facts.ts";
const root = "root";
const questionId = "choice";
export function question(answered: boolean): Scenario {
  return scenario(
    answered ? "question-steer-answered" : "question-steer",
    "Codex asks Tabs or Spaces",
    [
      // Codex 0.159.1 question.jsonl asks in agentMessage and echoes the selected label as userMessage.
      tool(root, "ask", {
        kind: "ask_user",
        title: "Do you prefer Tabs or Spaces?",
        detail: { kind: "ask_user" },
      }),
      {
        type: "interaction.opened",
        agent: root,
        interaction: questionId,
        item: "ask",
        blocking: false,
        request: {
          kind: "question",
          questions: [
            {
              id: "indent",
              header: "Indentation",
              text: "Tabs or Spaces?",
              multiSelect: false,
              allowOther: true,
              options: [
                { id: "tabs", label: "Tabs" },
                { id: "spaces", label: "Spaces" },
              ],
            },
          ],
        },
      },
      ...(answered
        ? [
            {
              type: "interaction.closed",
              interaction: questionId,
              state: "resolved",
              resolution: { kind: "question", answers: { indent: ["tabs"] } },
            } satisfies Fact,
            input("answer-echo", "Tabs", {
              kind: "interaction_answer",
              interactionId: InteractionId.parse(questionId),
            }),
            message(root, "reply", "assistant", "I'll use Tabs."),
          ]
        : []),
    ],
    answered
      ? {}
      : {
          pending: true,
          after: [
            {
              kind: "await",
              interaction: questionId,
              next: (resolution) => [
                {
                  kind: "facts",
                  facts: [
                    input(
                      "answer-echo",
                      resolution?.kind === "question"
                        ? (resolution.answers.indent ?? [])
                            .map((value) =>
                              value === "tabs" ? "Tabs" : value === "spaces" ? "Spaces" : value,
                            )
                            .join(", ")
                        : "Skipped",
                      {
                        kind: "interaction_answer",
                        interactionId: InteractionId.parse(questionId),
                      },
                    ),
                    message(root, "reply", "assistant", "Thanks, I'll use that preference."),
                    endTurn(root),
                  ],
                },
              ],
            },
          ],
        },
  );
}
export function delegation(): Scenario[] {
  const parentId = "thread-ux-delegation-results";
  const childId = "thread-ux-delegated-model-error";
  const error = {
    kind: "provider" as const,
    code: "model_not_found",
    title: "Claude Code doesn't recognise the model opus-5.5",
    message: "Choose an installed Claude Code model.",
    detail: '[claude-code:unrecognized_model] {"model":"opus-5.5"}',
  };
  const child = scenario(
    "delegated-model-error",
    "Delegated child with an unknown model",
    [
      {
        type: "item.upsert",
        agent: root,
        item: "error",
        draft: {
          type: "notice",
          complete: true,
          level: "error",
          text: error.message,
          code: error.code,
          title: error.title,
          detail: error.detail,
          raw: [{ type: "claude.result", data: { error: "model_not_found", model: "opus-5.5" } }],
        },
      },
      endTurn(root, "failed", error),
    ],
    {
      provider: "claude",
      pending: true,
      initialInput: input("task", "Role: greeter\n\nTask:\nWrite a short welcome message.", {
        kind: "spawn",
        parentThreadId: ThreadId.parse(parentId),
        role: "greeter",
      }),
    },
  );
  child.thread.parentThreadId = parentId;
  const parent = scenario("delegation-results", "Delegated work returns to the parent", [
    tool(root, "delegate", {
      kind: "agent.spawn",
      title: "Start greeter",
      detail: {
        kind: "agent.spawn",
        childAgent: "greeter",
        description: "Write a welcome message",
        agentType: "claude",
      },
    }),
    {
      type: "agent.seen",
      agent: "greeter",
      parent: root,
      spawnedBy: "delegate",
      origin: "ace",
      fidelity: "summary",
      name: "greeter",
      model: "opus-5.5",
      native: { provider: "claude", nativeId: "greeter" },
      cwd,
    },
    {
      type: "agent.external",
      agent: "greeter",
      threadId: ThreadId.parse(childId),
      status: { state: "failed" },
    },
    toolDone(root, "delegate", "failed"),
    input(
      "result",
      JSON.stringify({ results: [{ threadId: childId, outcome: "failed", error }] }),
      { kind: "subagent_result", threadIds: [ThreadId.parse(childId)] },
    ),
    message(root, "reply", "assistant", "The greeter couldn't start. Choose a model to retry."),
  ]);
  return [parent, child];
}
