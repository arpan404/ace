import type { Fact, Key } from "@ace/core";
import type { InteractionRequest } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { aceCall } from "./ace-tools.ts";
import { message, rootAgent, turn } from "./facts.ts";

/*
 * A Codex thread driving ace's browser while approvals pile up: ace's origin consent answered
 * "for this thread", asked again, and requests withdrawn as the agent moved on. The transcript
 * must keep one row per call, with the person's answer as that row's note.
 */

const originRequest = (url: string): InteractionRequest => ({
  kind: "approval",
  title: `open ${url} in the thread browser`,
  target: { tool: "ace_browser_navigate", access: "execute", input: { url } },
  options: [
    { id: "allow_once", label: "Allow once", kind: "allow_once" },
    { id: "allow_thread", label: "Allow for this thread", kind: "allow_session" },
    { id: "deny", label: "Deny", kind: "deny" },
  ],
});
const asked = (interaction: Key, url: string, item?: Key): Fact => ({
  type: "interaction.opened",
  agent: "root",
  interaction,
  blocking: true,
  request: originRequest(url),
  ...(item ? { item } : {}),
});
const allowed = (interaction: Key): Fact => ({
  type: "interaction.closed",
  interaction,
  state: "resolved",
  resolution: { kind: "approval", optionId: "allow_thread" },
});
const withdrawn = (interaction: Key): Fact => ({
  type: "interaction.closed",
  interaction,
  state: "cancelled",
});
const page = (url: string) => [{ type: "text" as const, text: JSON.stringify({ url }) }];

export function aceToolApprovals(): Scenario {
  const url = "https://arpan.sh/projects/skeladb";
  const withdrawnRequests = Array.from({ length: 8 }, (_, index) => `withdrawn-${index}`);
  return {
    thread: {
      id: "thread-ace-tool-approvals",
      workspaceId: "ace",
      title: "Check the skeladb project page",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "approvals",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Open arpan.sh and check the skeladb project page."),
          aceCall(
            "root",
            "visit",
            "ace_browser_navigate",
            { url: "https://arpan.sh" },
            page("https://arpan.sh"),
          ),
          aceCall("root", "go", "ace_browser_navigate", { url }, page(url)),
          asked("origin-1", url, "go"),
          allowed("origin-1"),
          asked("origin-2", url),
          allowed("origin-2"),
          asked("origin-3", url),
          allowed("origin-3"),
          ...withdrawnRequests.flatMap((id) => [asked(id, url), withdrawn(id)]),
          aceCall("root", "read", "ace_browser_snapshot", {}, page(url)),
        ],
      },
    ],
  };
}
