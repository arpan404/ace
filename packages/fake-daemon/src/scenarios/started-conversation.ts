import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

export const startedConversationIds = {
  source: "thread-separate-chat-source",
  started: "thread-separate-chat",
} as const;

const title = "Separate Codex chat";
const opening = "Hello - starting a separate chat on Codex.";

/**
 * An OpenCode thread whose agent started a separate top-level Codex conversation through ace's
 * `ace_thread_start` tool, as OpenCode reports the call (its result only in the raw snapshot),
 * and the conversation it started: the tool's opening message from the parent agent, then the
 * new agent's reply. Play `startedConversation()` whole.
 */
export function startedConversation(): Scenario[] {
  const args = {
    requestId: "separate-codex-001",
    title,
    text: opening,
    workspace: { kind: "project" },
    provider: "codex",
    model: "gpt-5.5",
    accountId: "codex-personal",
  };
  const answer = {
    ok: true,
    data: {
      threadId: startedConversationIds.started,
      title,
      provider: "codex",
      model: "gpt-5.5",
      account: "Personal",
      summary: `Started “${title}” with GPT-5.5 on the Personal account. It is in the person's sidebar and shown in this thread as a card with Open; tell them it's ready in a sentence and don't repeat its id, provider or account id.`,
    },
  };
  const call: Fact = {
    type: "item.upsert",
    agent: "root",
    item: "start-conversation",
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        kind: "mcp",
        title: "ace_ace_thread_start",
        status: "succeeded",
        detail: { kind: "mcp", server: "ace", tool: "ace_thread_start", arguments: args },
        raw: [
          {
            type: "snapshot.tool",
            name: "ace_ace_thread_start",
            data: {
              type: "tool",
              name: "ace_ace_thread_start",
              state: {
                status: "completed",
                input: args,
                content: [{ type: "text", text: JSON.stringify(answer) }],
              },
            },
          },
        ],
      },
    },
  };
  const source: Scenario = {
    thread: {
      id: startedConversationIds.source,
      workspaceId: "acme",
      title: "AI in education essay",
      provider: "opencode",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("opencode"),
          turn("root"),
          message("root", "ask", "user", "Write a short paragraph on AI in education."),
          message(
            "root",
            "essay",
            "assistant",
            "AI can widen access to tutoring and feedback, but only when it supports human teachers and learners. Without that, the same tools may deepen inequalities or distract from real understanding. The future of education will be shaped less by AI alone than by the choices people make about how to use it.",
          ),
          endTurn("root"),
          { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
          message("root", "ask-separate", "user", "I want a separate ace chat thread"),
          call,
          message(
            "root",
            "started",
            "assistant",
            `Started “${title}” with GPT-5.5 on your Personal account. It's ready when you are.`,
          ),
          { type: "turn.ended", agent: "root", nativeTurnId: "second", outcome: "completed" },
        ],
      },
    ],
  };
  const started: Scenario = {
    thread: {
      id: startedConversationIds.started,
      workspaceId: "acme",
      title,
      provider: "codex",
      execution: { provider: "codex", model: "gpt-5.5", instanceId: "codex-personal", options: {} },
      // The daemon records an agent-started conversation as sent: it is a task, not a draft.
      hasSentMessage: true,
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex"),
          turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "opening",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              synthetic: true,
              parts: [{ type: "text", text: opening }],
              origin: {
                kind: "parent_agent",
                parentThreadId: ThreadId.parse(startedConversationIds.source),
              },
            },
          },
          message(
            "root",
            "welcome",
            "assistant",
            "Welcome to the separate chat. This thread runs on Codex with GPT-5.5. What would you like to work on?",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
  return [source, started];
}
