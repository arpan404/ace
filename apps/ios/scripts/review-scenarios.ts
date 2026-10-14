import { FakeDaemon, facts } from "@ace/fake-daemon";

export function approvalRetryScenario(
  daemon: FakeDaemon,
  stage: "create" | "refuse" | "accept",
): void {
  if (stage === "refuse") daemon.refuseCommands("contract_refused", "interaction.resolve");
  else if (stage === "accept") daemon.restoreRequests();
  else {
    daemon.createThread({
      id: "ios-retry",
      workspaceId: "ace",
      title: "Approval recovery",
      provider: "codex",
      access: "ask",
    });
    daemon.apply("ios-retry", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.tool("root", "retry-tool", {
        kind: "shell",
        title: "Approval recovery",
        status: "awaiting_approval",
        detail: { kind: "shell", command: "printf review" },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "retry-approval",
        item: "retry-tool",
        blocking: true,
        request: {
          kind: "approval",
          title: "Approval recovery",
          options: [{ id: "deny", label: "Deny", kind: "deny" }],
        },
      },
    ]);
  }
}

/** Review regression scenarios, only activated by a local contract test. */
export function oversizedScenario(daemon: FakeDaemon, stage: "create" | "work" | "approval"): void {
  if (stage === "create") {
    daemon.createThread({
      id: "ios-large",
      workspaceId: "ace",
      title: "Short title",
      provider: "codex",
    });
    daemon.apply("ios-large", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.endTurn("root"),
    ]);
  } else if (stage === "work") {
    daemon.updateThread("ios-large", { title: "Large working title " + '🧭"\n'.repeat(12000) });
    daemon.apply("ios-large", [
      { type: "turn.started", agent: "root", nativeTurnId: "review-work", trigger: "user" },
    ]);
  } else {
    daemon.apply("ios-large", [
      facts.tool("root", "large-command", {
        kind: "shell",
        title: "Long shell command",
        status: "awaiting_approval",
        detail: { kind: "shell", command: "printf " + "x".repeat(40000) },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "large-approval",
        item: "large-command",
        blocking: true,
        request: {
          kind: "approval",
          title: "Long approval " + "x".repeat(40000),
          description: "d".repeat(40000),
          options: [
            { id: "option-" + "x".repeat(40000), label: "Deny " + "x".repeat(40000), kind: "deny" },
          ],
        },
      },
    ]);
  }
}
