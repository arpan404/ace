import { FakeDaemon, facts } from "@ace/fake-daemon";

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
          id: `action-${index}-` + "x".repeat(32768),
          label: `Choice ${index}`,
          kind: "deny",
        })),
      },
    },
  ]);
}
