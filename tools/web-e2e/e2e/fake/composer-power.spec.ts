import { expect, test } from "@playwright/test";
for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
  test(`inline references keep the caret through newlines and argument forms in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.addInitScript(
      (preset) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset })),
      theme,
    );
    await page.addInitScript(() => {
      Object.assign(globalThis, {
        aceFakeSetup(daemon: import("@ace/fake-daemon").FakeDaemon) {
          daemon.createThread({
            id: "composer-browser",
            workspaceId: "ace",
            provider: "codex",
            title: "Browser behavior",
          });
          daemon.apply("composer-browser", [
            {
              type: "agent.seen",
              agent: "root",
              origin: "root",
              fidelity: "full",
              native: { provider: "codex", nativeId: "root" },
              cwd: "/fixture/ace",
            },
          ]);
        },
      });
    });
    await page.goto("/t/composer-browser");
    const message = page.getByRole("combobox", { name: "Message" });
    await message.fill("Please /writing");
    await expect(page.getByRole("option", { name: /^writing / })).toBeVisible();
    await page.keyboard.press("Tab");
    await message.pressSequentially("first line");
    await page.keyboard.press("Shift+Enter");
    await message.pressSequentially("second line");
    await expect(message).toHaveText("Please writing first line\nsecond line");
    await message.fill("Use /explain");
    await expect(page.getByRole("option", { name: /^explain / })).toBeVisible();
    await page.keyboard.press("Enter");
    const form = page.getByRole("dialog", { name: "explain" });
    await form.getByRole("textbox", { name: "topic" }).fill("reconnects");
    await form.getByRole("button", { name: "Add command" }).click();
    await expect(message).toHaveText("Use explain ");
    await message.pressSequentially("carefully");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("feed", { name: "Transcript" })).toContainText(
      "Use explain carefully",
    );
    await expect(message).toBeEmpty();
  });
