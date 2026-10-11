import { chromium, expect as playwrightExpect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { FakeDaemon } from "@ace/fake-daemon";

const expect = playwrightExpect.configure({ timeout: 60_000 });

const out = "/tmp/ace-orch/shots/fix-audit-transcript-hygiene";
const base = process.env.ACE_HYGIENE_URL ?? "http://127.0.0.1:5264";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      await context.addInitScript((preset) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
        Object.assign(globalThis, {
          aceFakeWorld: "empty",
          aceFakeSetup: (daemon: FakeDaemon) => {
            daemon.services.providerLogin.dismiss("web-fake-device");
            daemon.createThread({
              id: "hygiene",
              workspaceId: "ace",
              title: "Check command output",
              provider: "cursor",
            });
            daemon.apply("hygiene", [
              {
                type: "agent.seen",
                agent: "root",
                origin: "root",
                fidelity: "full",
                native: { provider: "cursor" },
                cwd: "/synthetic/project",
              },
              { type: "turn.started", agent: "root", nativeTurnId: "one", trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: "ask",
                draft: {
                  type: "message",
                  role: "user",
                  complete: true,
                  parts: [
                    {
                      type: "text",
                      text: "<system-reminder>private injected text</system-reminder>Check the command output and delegate the review.",
                    },
                  ],
                },
              },
              {
                type: "item.upsert",
                agent: "root",
                item: "diagnostic",
                draft: {
                  type: "notice",
                  level: "warning",
                  code: "cursor.diagnostic",
                  diagnostic: true,
                  text: "SDK task summary has no independent child identity",
                  complete: true,
                },
              },
              {
                type: "item.upsert",
                agent: "root",
                item: "shell",
                draft: {
                  type: "tool_call",
                  complete: true,
                  call: {
                    kind: "shell",
                    title: "printf output",
                    status: "succeeded",
                    detail: {
                      kind: "shell",
                      command: "printf output",
                      output:
                        "\u001b[32mAll checks passed\u001b[0m\n\u001b]8;;https://example.com\u001b\\View results\u001b]8;;\u001b\\",
                    },
                    raw: [],
                  },
                },
              },
              { type: "turn.ended", agent: "root", nativeTurnId: "one", outcome: "completed" },
              {
                type: "item.upsert",
                agent: "root",
                item: "answer",
                draft: {
                  type: "message",
                  role: "assistant",
                  complete: true,
                  parts: [
                    {
                      type: "text",
                      text: "The checks passed. I'll ask another device to review the changes.",
                    },
                  ],
                },
              },
              { type: "turn.started", agent: "root", nativeTurnId: "two", trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: "next",
                draft: {
                  type: "message",
                  role: "user",
                  complete: true,
                  parts: [{ type: "text", text: "Wait for the review." }],
                },
              },
              {
                type: "item.upsert",
                agent: "root",
                item: "wait",
                draft: {
                  type: "tool_call",
                  complete: false,
                  call: {
                    kind: "mcp",
                    title: "ace_device_task_wait",
                    status: "running",
                    detail: {
                      kind: "mcp",
                      server: "ace",
                      tool: "ace_device_task_wait",
                      arguments: { taskId: "native-private-id" },
                    },
                    raw: [],
                  },
                },
              },
            ]);
          },
        });
      }, theme);
      const page = await context.newPage();
      await page.goto(`${base}/t/hygiene`);
      const feed = page.getByRole("feed", { name: "Transcript" });
      await expect(
        feed.getByText("Check the command output and delegate the review."),
      ).toBeVisible();
      if (width === 1440)
        await expect(page.getByText(/work on another device/).first()).toBeVisible();
      await expect(feed).not.toContainText(/SDK|system-reminder|ace_device|native-private-id/);
      await expect(
        feed.getByText("The checks passed. I'll ask another device to review the changes."),
      ).toBeVisible();
      await expect(feed.getByRole("status", { name: "Loading message" })).toHaveCount(0);
      await page.getByRole("button", { name: /^Worked for/ }).click();
      await page.getByRole("button", { name: /Ran printf output/ }).click();
      await expect(page.getByLabel("Output", { exact: true })).toHaveText(
        "All checks passed\nView results",
      );
      await expect(page.getByRole("navigation", { name: "Conversation turns" })).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      if (theme === "light" || theme === "dark")
        await page.screenshot({
          path: `${out}/transcript-${theme}-${width}.png`,
          animations: "disabled",
        });
      console.log(`${theme} ${width} passed`);
      await context.close();
    }
} finally {
  await browser.close();
}
