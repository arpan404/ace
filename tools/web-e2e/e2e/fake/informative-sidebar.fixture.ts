import type { FakeDaemon } from "@ace/fake-daemon";
import type { Page } from "@playwright/test";

/** Real-shaped facts, including old local names, remote machines, requests and mixed PR states. */
export async function stageInformativeSidebar(page: Page, theme: string) {
  await page.addInitScript((preset) => {
    localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
    Object.assign(globalThis, {
      aceFakeWorld: "empty",
      aceFakeSetup: (daemon: FakeDaemon) => {
        daemon.services.providerLogin.dismiss("web-fake-device");
        daemon.services.settings.seed({
          "host.displayName": "Workshop Mac",
          "threads.autoSettleAfter": "never",
          "host.icon": { kind: "desktop", color: "blue" },
        });
        daemon.services.accounts = daemon.services.accounts.filter(
          (account) =>
            account.provider !== "claude" ||
            ["claude-personal", "claude-work"].includes(account.id),
        );
        daemon.services.models = daemon.services.models.filter(
          (model) =>
            model.provider !== "claude" ||
            ["claude-personal", "claude-work"].includes(model.instance ?? ""),
        );
        const titles = [
          "Review the release plan",
          "Choose a retry policy",
          "Build replay recovery",
          "Run the mobile checks",
          "Publish the release",
          "Retry workspace sync",
          "Fix a flaky browser test",
          "Write the install guide",
          "Tidy the README",
          "Remove the old queue reader",
          "Bump the client SDK",
        ];
        for (const [index, title] of titles.entries()) {
          const id = `live-${index}`;
          const provider = index === 4 || index === 7 ? "opencode" : index % 2 ? "claude" : "codex";
          const remote = index === 4;
          const age = index >= 7 ? (index - 6) * 86_400_000 : (index + 1) * 20_000;
          daemon.createThread(
            {
              id,
              title,
              provider,
              workspaceId: index === 3 ? "mobile" : "ace",
              ...(provider === "claude"
                ? { live: { account: "claude-personal", model: "claude-opus-5-5" } }
                : {}),
              details: {
                workspace: {
                  id: index === 3 ? "mobile" : "ace",
                  name: index === 3 ? "Mobile" : "ace",
                  path: "/tmp/synthetic-project",
                },
                machine: remote
                  ? {
                      host: "build-server",
                      name: "Build server",
                      icon: { kind: "server", color: "purple" },
                    }
                  : { host: daemon.hostId, name: "Old-Mac.local" },
                ...(index === 8
                  ? {}
                  : {
                      branch: [
                        "release/review",
                        "fix/retry-policy",
                        "fix/replay",
                        "mobile/checks",
                        "release/build",
                        "fix/workspace-sync",
                        "fix/browser-retry",
                        "docs/install",
                        "",
                        "cleanup/queue",
                        "deps/client-sdk",
                      ][index],
                    }),
                ...(index === 0 || index === 2 || index === 9 || index === 10
                  ? {
                      linkedPr: {
                        number: 281 + index,
                        state: index === 9 ? "closed" : index === 10 ? "merged" : "open",
                        draft: index === 2,
                      },
                    }
                  : {}),
                ...(index < 7
                  ? { diff: { files: 2, additions: 18 + index * 3, deletions: 4 + index } }
                  : {}),
              },
            },
            age,
          );
          daemon.apply(
            id,
            [
              {
                type: "agent.seen",
                agent: "root",
                origin: "root",
                fidelity: "full",
                native: { provider, nativeId: "root" },
                cwd: "/tmp/synthetic-project",
              },
              { type: "turn.started", agent: "root", nativeTurnId: "root-turn", trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: "sent",
                draft: {
                  type: "message",
                  role: "user",
                  complete: true,
                  parts: [{ type: "text", text: title }],
                },
              },
            ],
            age,
          );
          if (index < 2)
            daemon.apply(
              id,
              [
                {
                  type: "interaction.opened",
                  agent: "root",
                  interaction: "request",
                  blocking: true,
                  request:
                    index === 0
                      ? {
                          kind: "approval",
                          title: "Publish the release plan",
                          options: [
                            { id: "allow", label: "Allow once", kind: "allow_once" },
                            { id: "deny", label: "Deny", kind: "deny" },
                          ],
                        }
                      : {
                          kind: "question",
                          questions: [
                            {
                              id: "policy",
                              text: "Which retry policy?",
                              multiSelect: false,
                              allowOther: true,
                              options: [],
                            },
                          ],
                        },
                },
              ],
              age,
            );
          else if (index === 2) {
            for (const agent of ["web", "mobile"])
              daemon.apply(
                id,
                [
                  {
                    type: "agent.seen",
                    agent,
                    parent: "root",
                    origin: "provider_subagent",
                    fidelity: "full",
                    native: { provider, nativeId: agent },
                    cwd: "/tmp/synthetic-project",
                  },
                  { type: "turn.started", agent, nativeTurnId: `${agent}-turn`, trigger: "spawn" },
                ],
                age,
              );
            daemon.apply(
              id,
              [
                {
                  type: "item.upsert",
                  agent: "root",
                  item: "wait-for-checks",
                  draft: {
                    type: "tool_call",
                    complete: false,
                    call: {
                      kind: "agent.spawn",
                      title: "Run web and mobile checks",
                      detail: { kind: "agent.spawn", description: "Run checks" },
                      status: "running",
                      raw: [],
                    },
                  },
                },
                {
                  type: "subagents.waiting",
                  agent: "root",
                  item: "wait-for-checks",
                  targets: [],
                },
              ],
              age,
            );
          } else if (index === 5)
            daemon.apply(
              id,
              [
                {
                  type: "retry",
                  agent: "root",
                  on: "rate_limit",
                  until: Date.now() + 20 * 60_000,
                  message: "Usage limit reached",
                },
              ],
              age,
            );
          else if (index >= 6)
            daemon.apply(
              id,
              [
                {
                  type: "turn.ended",
                  agent: "root",
                  nativeTurnId: "root-turn",
                  outcome: index === 6 ? "failed" : "completed",
                },
              ],
              age,
            );
        }
        daemon.createThread({
          id: "empty-draft",
          workspaceId: "ace",
          provider: "opencode",
          title: "New thread",
        });
      },
    });
  }, theme);
}
