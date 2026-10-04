import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, toolDone, turn } from "./facts.ts";

const cwd = "/Users/dev/relay";
export const delegatedDocsIds = {
  parent: "thread-relay-docs",
  child: "thread-relay-docs-codex",
} as const;

const prompt = [
  "Write docs/protocol/relay.md from packages/protocol/src/relay.ts.",
  "- One section per frame type, with its fields and an example.",
  "- Say which frames are acked and what a client does on a gap.",
  "- Keep it under 400 lines; link the ADR instead of repeating it.",
].join("\n");

/**
 * A Claude thread that delegated the relay protocol reference to Codex through ace (ADR 0052):
 * the delegate is an agent of the tree whose work is a thread of its own, now finished. The
 * agent tab shows the delegation record, the child thread's transcript and a follow-up that
 * goes to that thread. Play `delegatedDocs()` whole: the parent first, then the child thread it delegated.
 */
export function delegatedDocs(): Scenario[] {
  const child: Scenario = {
    thread: {
      id: delegatedDocsIds.child,
      workspaceId: "relay",
      title: "Relay protocol reference",
      provider: "codex",
      parentThreadId: delegatedDocsIds.parent,
    },
    steps: [
      {
        kind: "facts",
        agoMs: 4 * 60_000,
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          message("root", "ask", "user", prompt),
          tool("root", "read-schema", {
            kind: "file.read",
            title: "Read packages/protocol/src/relay.ts",
            detail: { kind: "file.read", path: "packages/protocol/src/relay.ts" },
          }),
          toolDone("root", "read-schema"),
          message(
            "root",
            "progress",
            "assistant",
            "Drafted the frame table for `hello`, `resume` and `ack`, then the gap-handling section: docs/protocol/relay.md is 312 lines and links ADR 0006 for windowing.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
  const delegate: Fact[] = [
    tool("root", "delegate-docs", {
      kind: "agent.spawn",
      title: "Delegate the relay protocol reference to Codex",
      detail: {
        kind: "agent.spawn",
        description: "Write docs/protocol/relay.md from the wire schemas",
        prompt,
        agentType: "codex",
        childAgent: "docs",
      },
    }),
    {
      type: "agent.seen",
      agent: "docs",
      parent: "root",
      spawnedBy: "delegate-docs",
      origin: "ace",
      fidelity: "full",
      native: { provider: "codex", nativeId: "docs" },
      cwd,
      name: "protocol-docs",
      model: "gpt-5.5-codex",
    },
    {
      type: "agent.external",
      agent: "docs",
      threadId: ThreadId.parse(delegatedDocsIds.child),
      status: { state: "done" },
    },
  ];
  const parent: Scenario = {
    thread: {
      id: delegatedDocsIds.parent,
      workspaceId: "relay",
      title: "Relay docs for 0.9",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 5 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "The 0.9 release needs a protocol reference for the relay. Have Codex write it while you update the changelog.",
          ),
          ...delegate,
          message(
            "root",
            "handoff",
            "assistant",
            "Codex wrote the reference in its own thread (docs/protocol/relay.md); I've updated the changelog to link it.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
  return [parent, child];
}
