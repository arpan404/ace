import { ultraPreviewModel } from "./ultra-model.ts";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

/** A deterministic live-preview route for Ultra tint, long-name truncation and Fast identity. */
export function ultraReasoningPreview(): Scenario {
  return {
    thread: {
      id: "thread-ultra-reasoning-preview",
      workspaceId: "relay",
      title: "Ultra reasoning preview",
      provider: "codex",
      details: {
        branch: "preview/ultra",
        mode: "local",
        machine: { host: "fake-host", name: "This machine" },
        workspace: { id: "relay", name: "relay", path: "/Users/dev/relay" },
      },
      execution: {
        provider: "codex",
        instanceId: "codex-personal",
        model: ultraPreviewModel.id,
        options: { effort: "ultra", serviceTier: "priority" },
      },
    },
    steps: [
      {
        kind: "facts",
        label: "preview",
        facts: [
          rootAgent("codex", "/Users/dev/relay"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Show Ultra reasoning with a long simulated model name and Fast enabled.",
          ),
          message(
            "root",
            "answer",
            "assistant",
            "This is a simulated preview. Ultra is explicitly supported by this fake model; no provider is contacted. Use the composer’s effort menu to compare High and Ultra.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}
