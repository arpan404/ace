import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { uncommittedPatch } from "./retour-copy-fixtures.ts";
const out = "/tmp/ace-orch/shots/ui/retour-copy";
const base = process.env.ACE_COPY_URL ?? "http://127.0.0.1:5249";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of (process.env.ACE_COPY_THEMES ?? "light,dark").split(","))
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (value) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: value })),
        theme,
      );
      await context.addInitScript((patch) => {
        Object.assign(globalThis, {
          aceFakeSetup: (daemon: {
            workspace: { setGitDiff(threadId: string, patch: string): void };
          }) => daemon.workspace.setGitDiff("thread-cold-start", patch),
        });
      }, uncommittedPatch);
      const page = await context.newPage();
      const shot = async (name: string) => {
        await page.screenshot({
          path: `${out}/${name}-${theme}-${width}.png`,
          animations: "disabled",
        });
        console.log(`${name}-${theme}-${width}`);
      };
      await page.goto(`${base}/skills/engineering~skill~code-review`);
      await expect(
        page.getByRole("heading", { name: "Code Review", exact: true, level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Code Review", exact: true, level: 3 }),
      ).toBeVisible();
      await shot("skills");
      await page.goto(`${base}/t/thread-cold-start`);
      const message = page.getByRole("combobox", { name: "Message", exact: true });
      await message.fill("/");
      await expect(page.getByRole("listbox", { name: "Add and commands" })).toBeVisible();
      await shot("slash");
      await message.fill("/code-review");
      await expect(page.getByRole("option", { name: /^Code Review / })).toBeVisible();
      await shot("slash-skill");
      await message.fill("");
      await page.getByRole("button", { name: /^Approvals:/ }).click();
      await expect(
        page.getByRole("menuitemradio", { name: "Provider default", exact: true }),
      ).toBeVisible();
      await shot("permissions");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open diff", exact: true }).first().click();
      const panel = page.getByRole("region", { name: "Thread panel" });
      await expect(panel.getByRole("button", { name: /^Scope:/ })).toBeVisible();
      await panel.getByRole("button", { name: /^Scope:/ }).click();
      await page.getByRole("menuitemradio", { name: /^Last turn/ }).click();
      await shot("diff-last-turn");
      for (const scope of ["Uncommitted", "This thread"]) {
        await panel.getByRole("button", { name: /^Scope:/ }).click();
        await page.getByRole("menuitemradio", { name: scope, exact: true }).click();
        await expect(
          panel.getByRole("button", { name: `Scope: ${scope}`, exact: true }),
        ).toBeVisible();
        if (scope === "Uncommitted")
          await expect(panel.getByLabel("Uncommitted diff", { exact: true })).toBeVisible();
        await shot(scope === "Uncommitted" ? "diff-uncommitted" : "diff-thread");
      }
      await page.goto(`${base}/t/thread-bump-codex`);
      await page.getByRole("button", { name: /^Approvals:/ }).click();
      await expect(
        page.getByRole("menuitemradio", { name: "Read only", exact: true }),
      ).toBeVisible();
      await shot("permissions-codex");
      await page.keyboard.press("Escape");
      await page.goto(`${base}/t/thread-ux-delegated-model-error`);
      await expect(
        page
          .getByRole("feed", { name: "Transcript" })
          .getByText(/doesn't recognise the model “opus-5.5”/),
      ).toBeVisible();
      await expect(page.getByText("Write a short welcome message.", { exact: true })).toBeVisible();
      await shot("delegated-error");
      await page.goto(`${base}/accounts`);
      await expect(page.getByRole("heading", { name: "Usage & accounts", level: 1 })).toBeVisible();
      await expect(
        page.getByRole("article", { name: "Claude Code Personal", exact: true }),
      ).toBeVisible();
      await shot("account-times");
      await page.goto(`${base}/settings/prompts`);
      await expect(page.getByRole("list", { name: "Prompt files" })).toBeVisible();
      await shot("prompts");
      await page.getByRole("button", { name: /unfinished/ }).click();
      await expect(page.getByRole("textbox", { name: "Prompt content" })).toBeVisible();
      await shot("prompt-edit");
      await page.goto(`${base}/settings/notifications`);
      await expect(page.getByRole("switch", { name: "Agent messages" })).toBeVisible();
      await shot("notifications");
      await page.goto(`${base}/settings/providers/cursor`);
      await expect(page.getByText("Your Cursor login", { exact: true })).toBeVisible();
      await shot("cursor");
      await page.goto(`${base}/settings/providers/opencode`);
      await expect(page.getByRole("list", { name: "OpenCode services" })).toBeVisible();
      await shot("opencode");
      await page.goto(`${base}/settings/providers/codex`);
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      const accountForm = page.getByRole("form", { name: "Add account", exact: true });
      await accountForm.getByRole("textbox").fill("Work2");
      await accountForm.getByRole("combobox", { name: "Sign-in method", exact: true }).click();
      await page.getByRole("option", { name: "API key", exact: true }).click();
      await accountForm.getByRole("button", { name: "Add and sign in", exact: true }).click();
      await page.getByLabel("OpenAI API key", { exact: true }).fill("fake-copy-key");
      await page.getByRole("button", { name: "Use key", exact: true }).click();
      await expect(page.getByText("Signed in to Codex · Work2", { exact: true })).toBeVisible();
      await shot("sign-in-toast");
      await page.goto(`${base}/settings/advanced`);
      await page.getByRole("button", { name: "Run checks" }).click();
      await expect(
        page.getByRole("list", { name: "Check results" }).getByText("Gemini CLI", { exact: true }),
      ).toBeVisible();
      await shot("checks");
      await page.goto(`${base}/settings/remote`);
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Pair a device" })).toBeVisible();
      await page.getByRole("button", { name: "View and act", exact: true }).click();
      await page.getByRole("button", { name: "Show pairing code" }).click();
      await expect(page.getByLabel("Pairing link", { exact: true })).toBeVisible();
      await shot("pairing");
      await page.goto(`${base}/settings/providers`);
      await page
        .getByRole("region", { name: "ACP agents" })
        .getByRole("button", { name: "Add", exact: true })
        .click();
      await expect(page.getByRole("option", { name: /Gemini CLI/ })).toBeVisible();
      await shot("registry");
      await page.goto(`${base}/automations/auto-dependency-audit`);
      await page
        .getByRole("button", {
          name: "Open the run 2 advisories · opened a thread in ace",
          exact: true,
        })
        .click();
      await expect(page.getByRole("link", { name: "Open thread", exact: true })).toBeVisible();
      await shot("automation");
      await page.goto(`${base}/settings/computer-use?fakeWorld=computer-use`);
      await expect(page.getByRole("list", { name: "Live sessions" })).toBeVisible();
      await shot("computer-use");
      await context.close();
    }
} finally {
  await browser.close();
}
