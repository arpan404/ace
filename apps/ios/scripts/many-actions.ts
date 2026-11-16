import { FakeDaemon, facts } from "@ace/fake-daemon";

/**
 * Each action id's padding: 300 such actions stay under the 64 Ki characters a request may be and
 * still go whole (ADR 0157), so the phone gets every one and answers one exactly.
 */
const actionIdPad = 100;

export function manyActions(daemon: FakeDaemon, id: string): void {
  daemon.createThread({
    hasSentMessage: true,
    id,
    workspaceId: "ace",
    title: "Many approval actions",
    provider: "codex",
    access: "ask",
  });
  daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    // Enough transcript that the thread's snapshot goes in parts, while the approval itself stays
    // small enough to go whole (ADR 0157): the phone still meets fragmented snapshots here.
    ...Array.from({ length: 40 }, (_, index) =>
      facts.message("root", `filler-${index}`, "assistant", `Step ${index}: ${"y".repeat(4000)}`),
    ),
    facts.tool("root", "many-tool", {
      kind: "shell",
      title: "Choose an action",
      status: "awaiting_approval",
      detail: { kind: "shell", command: "printf review" },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "many-approval",
      item: "many-tool",
      blocking: true,
      request: {
        kind: "approval",
        title: "Choose an action",
        options: Array.from({ length: 300 }, (_, index) => ({
          id: `action-${index}-` + "x".repeat(actionIdPad),
          label: `Choice ${index}`,
          kind: "deny",
        })),
      },
    },
  ]);
}
