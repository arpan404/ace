import { expect, test } from "@playwright/test";
import type { FakeDaemon } from "@ace/fake-daemon";

declare global {
  interface Window {
    scrollWork: { append(): void; updates: number };
  }
}

function seed() {
  Object.assign(globalThis, {
    aceFakeSetup: (daemon: FakeDaemon) => {
      const id = "working-scroll";
      daemon.createThread({ id, workspaceId: "ace", provider: "codex", title: "Working" });
      daemon.apply(id, [
        {
          type: "agent.seen",
          agent: "root",
          origin: "root",
          fidelity: "full",
          native: { provider: "codex", nativeId: "root" },
          cwd: "/tmp/working-scroll",
        },
        { type: "turn.started", agent: "root", nativeTurnId: "live", trigger: "user" },
        {
          type: "item.upsert",
          agent: "root",
          item: "ask",
          draft: {
            type: "message",
            role: "user",
            complete: true,
            parts: [{ type: "text", text: "Keep working while I read" }],
          },
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "answer",
          draft: {
            type: "message",
            role: "assistant",
            complete: false,
            parts: [
              {
                type: "text",
                text: Array.from(
                  { length: 30 },
                  (_, i) => `Reading paragraph ${i}. ` + "Here is some text to read. ".repeat(25),
                ).join("\n\n"),
              },
            ],
          },
        },
      ]);
      window.scrollWork = {
        updates: 0,
        append() {
          const n = ++this.updates;
          daemon.apply(id, [
            {
              type: "item.upsert",
              agent: "root",
              item: `step-${n}`,
              draft: {
                type: "tool_call",
                complete: true,
                call: {
                  kind: "shell",
                  title: `Inspect file ${n}`,
                  status: "succeeded",
                  raw: [],
                  detail: { kind: "shell", command: `cat file-${n}` },
                },
              },
            },
            {
              type: "item.upsert",
              agent: "root",
              item: `note-${n}`,
              draft: {
                type: "message",
                role: "assistant",
                complete: true,
                parts: [
                  { type: "text", text: `Progress update ${n}. ` + "More output. ".repeat(30) },
                ],
              },
            },
          ]);
        },
      };
    },
  });
}

for (const distance of [40, 400, 1500]) {
  test(`reader ${distance}px above the end stays put during agent updates`, async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(seed);
    await page.goto("/t/working-scroll", { waitUntil: "domcontentloaded" });
    const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
    await expect(viewport.getByText("Reading paragraph 29.", { exact: false })).toBeVisible({
      timeout: 60000,
    });
    // Wait for markdown measurement and the initial placement at the live end.
    await expect
      .poll(() =>
        viewport.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop)),
      )
      .toBeLessThan(2);
    await viewport.hover();
    await page.mouse.wheel(0, -distance);
    await expect(page.getByRole("button", { name: /^Scroll to end/ })).toBeVisible();
    const before = await viewport.evaluate((el) => el.scrollTop);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollWork.append());
      await page.waitForTimeout(120);
      expect(await viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
    }
    // Returning to live must still follow subsequent output.
    await page.getByRole("button", { name: /^Scroll to end/ }).click();
    await page.evaluate(() => window.scrollWork.append());
    await expect
      .poll(() =>
        viewport.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop)),
      )
      .toBeLessThan(2);
  });
}
