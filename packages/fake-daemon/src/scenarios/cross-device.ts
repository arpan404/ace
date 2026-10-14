import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { message, rootAgent, tool, toolDone, turn } from "./facts.ts";

const cwd = "/Users/dev/relay";
const child = ThreadId.parse("machine-studio-review");
const mcp = (item: string, name: string, args: Record<string, unknown>): Fact =>
  tool("root", item, {
    kind: "mcp",
    title: name,
    detail: { kind: "mcp", server: "ace", tool: name, arguments: args },
  });

/**
 * A MacBook thread working across the person's machines (ADR 0078): it lists them, delegates
 * a review to the Studio desktop, and reads a page in the Studio's browser. The child runs
 * there, so its row and the tool rows name the machine. `?fakeWorld=cross-device`.
 */
export function crossDevice(): Scenario {
  return {
    thread: {
      id: "thread-cross-device",
      workspaceId: "relay",
      title: "Check the 0.9 build on the Studio",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 3 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Run the 0.9 review on the Studio, it has the GPU build, and check the staging docs page in its browser.",
          ),
          mcp("machines", "ace_machines", {}),
          toolDone("root", "machines"),
          mcp("delegate", "delegate_task", {
            requestId: "studio-review",
            task: "Review the 0.9 GPU build and report failing benchmarks",
            role: "GPU build review",
            provider: "codex",
            machine: "studio",
            project: "relay",
          }),
          toolDone("root", "delegate"),
          {
            type: "item.upsert",
            agent: "root",
            item: "studio-delegation",
            draft: {
              type: "delegation.started",
              origin: "ace",
              childThreadId: child,
              provider: "codex",
              model: "gpt-5.5-codex",
              title: "GPU build review",
              role: "GPU build review",
              phase: "running",
              status: { state: "working", agents: 1 },
              updatedAt: 1,
              generation: 0,
              complete: false,
              outcome: null,
              machine: { machine: "studio", name: "Studio" },
            },
          },
          {
            type: "background.started",
            owner: "ace",
            agent: "root",
            task: `ace-machine:${child}`,
            kind: "subagent",
            title: "GPU build review · Studio",
            stoppable: true,
          },
          mcp("browse", "ace_browser_open", {
            url: "https://staging.relay.dev/docs/0.9",
            machine: "studio",
          }),
          toolDone("root", "browse"),
          message(
            "root",
            "progress",
            "assistant",
            "The review is running on the Studio. Its browser has the staging docs open; the 0.9 page renders and links to the new relay reference.",
          ),
        ],
      },
    ],
  };
}
