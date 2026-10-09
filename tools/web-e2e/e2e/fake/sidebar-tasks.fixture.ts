import type { FakeDaemon } from "@ace/fake-daemon";
import type { Page } from "@playwright/test";

/** Synthetic short-title and no-branch cases; no personal transcript is copied. */
export async function stageSidebarTasks(page: Page, theme = "dark") {
  await page.addInitScript((chosenTheme) => {
    localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosenTheme }));
    Object.assign(globalThis, {
      aceFakeWorld: "empty",
      aceFakeSetup: (daemon: FakeDaemon) => {
        daemon.services.providerLogin.dismiss("web-fake-device");
        const titles = [
          "yo!",
          "greeting",
          "Hi bro",
          "Audit Console Feature Gaps",
          "Build Agent State Engine",
          "New thread",
          "independent browser-path check with a deliberately long task title",
        ];
        for (const [index, title] of titles.entries()) {
          const id = `sidebar-${index}`;
          const provider = index % 2 === 0 ? "codex" : "claude";
          daemon.createThread(
            {
              id,
              workspaceId: "openforge",
              title,
              provider,
              details: {
                workspace: { id: "openforge", name: "OpenForge", path: "/tmp/fake/openforge" },
                machine: {
                  host: index === 2 ? "build-server" : daemon.hostId,
                  name: index === 2 ? "Build server" : "This Mac",
                },
                ...(index === 3
                  ? {
                      branch: "console/consistency",
                      diff: { files: 2, additions: 3, deletions: 1 },
                    }
                  : {}),
                ...(index === 4
                  ? { branch: "feat/agent-state", linkedPr: { number: 5, state: "merged" } }
                  : {}),
              },
            },
            index * 3_600_000,
          );
          if (index === 5) continue;
          daemon.apply(
            id,
            [
              {
                type: "agent.seen",
                agent: "root",
                origin: "root",
                fidelity: "full",
                native: { provider, nativeId: "root" },
                cwd: "/tmp/fake/openforge",
              },
              { type: "turn.started", agent: "root", nativeTurnId: "turn", trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: "message",
                draft: {
                  type: "message",
                  role: "user",
                  complete: true,
                  parts: [{ type: "text", text: title }],
                },
              },
              ...(index === 3
                ? []
                : [
                    {
                      type: "turn.ended" as const,
                      agent: "root",
                      nativeTurnId: "turn",
                      outcome: "completed" as const,
                    },
                  ]),
            ],
            index * 3_600_000,
          );
        }
      },
    });
  }, theme);
}
