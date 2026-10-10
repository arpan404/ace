import { expect, test } from "@playwright/test";
import type { FakeDaemon } from "@ace/fake-daemon";

for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"]) {
  for (const width of [1440, 390])
    test(`machine rows and editor in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((preset) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
        Object.assign(globalThis, {
          aceFakeWorld: "empty",
          aceFakeSetup: (daemon: FakeDaemon) => {
            daemon.services.providerLogin.dismiss("web-fake-device");
            daemon.services.settings.seed({
              "host.displayName": "Workshop Mac",
              "host.icon": { kind: "desktop", color: "blue" },
            });
            for (const remote of [false, true]) {
              const id = remote ? "remote-task" : "local-task";
              daemon.createThread({
                id,
                workspaceId: "ace",
                title: remote ? "Build release" : "Fix replay cursor",
                provider: "opencode",
                details: {
                  workspace: { id: "ace", name: "ace", path: "/tmp/synthetic-project" },
                  machine: remote
                    ? {
                        host: "remote-server",
                        name: "Build server",
                        icon: { kind: "server", color: "purple" },
                      }
                    : { host: daemon.hostId, name: "Old-Mac.local" },
                },
              });
              daemon.apply(id, [
                {
                  type: "agent.seen",
                  agent: "root",
                  origin: "root",
                  fidelity: "full",
                  native: { provider: "opencode", nativeId: "root" },
                  cwd: "/tmp/synthetic-project",
                },
                { type: "turn.started", agent: "root", nativeTurnId: "root-turn", trigger: "user" },
                {
                  type: "item.upsert",
                  agent: "root",
                  item: "ask",
                  draft: {
                    type: "message",
                    role: "user",
                    complete: true,
                    parts: [{ type: "text", text: "Investigate the replay cursor" }],
                  },
                },
                {
                  type: "turn.ended",
                  agent: "root",
                  nativeTurnId: "root-turn",
                  outcome: "completed",
                },
              ]);
            }
            daemon.createThread({
              id: "empty-draft",
              workspaceId: "ace",
              title: "New thread",
              provider: "opencode",
            });
          },
        });
      }, theme);
      await page.goto("/new");
      await page.getByRole("heading", { name: "New thread", exact: true }).waitFor();
      if (width === 390) await page.getByRole("button", { name: "Back to threads" }).click();
      const threads = page.getByRole("list", { name: "Threads", exact: true });
      await expect(threads.getByRole("link", { name: /^Fix replay cursor/ })).toBeVisible();
      await expect(threads.getByRole("link", { name: /^Build release/ })).toBeVisible();
      const machine = threads.getByText("· Build server", { exact: true });
      await expect(machine).toBeHidden();
      await threads.getByRole("link", { name: /^Build release/ }).hover();
      await expect(machine).toBeVisible();
      await page.mouse.move(width - 2, 2);
      await expect(machine).toBeHidden();
      await expect(threads.getByText("Workshop Mac", { exact: true })).toHaveCount(0);
      await expect(threads.getByText("New thread", { exact: true })).toHaveCount(0);
      if (theme === "light" || theme === "dark")
        await page.screenshot({
          path: `/tmp/ace-orch/shots/ui-thread-row-refine/machine-sidebar-${theme}-${width}.png`,
        });
      await page.goto("/settings/remote");
      await page.getByRole("button", { name: "Edit this machine", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "This machine", exact: true });
      await expect(editor).toBeVisible();
      await editor.getByRole("button", { name: "Server", exact: true }).click();
      await expect(editor.getByRole("button", { name: "Server", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      if (theme === "light" || theme === "dark")
        await page.screenshot({
          path: `/tmp/ace-orch/shots/ui-thread-row-refine/machine-editor-${theme}-${width}.png`,
        });
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(
        page
          .getByRole("region", { name: "Machines", exact: true })
          .getByRole("img", { name: "server machine icon" }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
}
