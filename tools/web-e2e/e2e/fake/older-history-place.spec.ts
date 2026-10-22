import { expect, test } from "@playwright/test";
import type { FakeDaemon } from "@ace/fake-daemon";

/*
 * A busy agent fills the live tail with tool steps, so the tail is only a few rows tall and the
 * reader's first scroll up already reaches its top: older history pages in right away. The view
 * must hold the row the reader was on, even when that page lands before the next frame.
 */

declare global {
  interface Window {
    heldFrames: { hold(): void; release(): void };
  }
}

function seed() {
  const id = "older-history-place";
  Object.assign(globalThis, {
    aceFakeSetup: (daemon: FakeDaemon) => {
      daemon.createThread({ id, workspaceId: "ace", provider: "codex", title: "Busy agent" });
      daemon.apply(id, [
        {
          type: "agent.seen",
          agent: "root",
          origin: "root",
          fidelity: "full",
          native: { provider: "codex", nativeId: "root" },
          cwd: "/tmp/busy",
        },
      ]);
      for (let turn = 0; turn < 24; turn++) {
        const nativeTurnId = `turn-${turn}`;
        daemon.apply(id, [
          { type: "turn.started", agent: "root", nativeTurnId, trigger: "user" },
          {
            type: "item.upsert",
            agent: "root",
            item: `ask-${turn}`,
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [{ type: "text", text: `Question ${turn}` }],
            },
          },
        ]);
        for (let step = 0; step < 20; step++) {
          const item = `step-${turn}-${step}`;
          const command = `rg needle-${turn}-${step}`;
          daemon.apply(id, [
            {
              type: "item.upsert",
              agent: "root",
              item,
              draft: {
                type: "tool_call",
                complete: false,
                call: {
                  kind: "shell",
                  title: command,
                  status: "running",
                  raw: [],
                  detail: { kind: "shell", command },
                },
              },
            },
            {
              type: "item.upsert",
              agent: "root",
              item,
              draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
            },
          ]);
        }
        daemon.apply(id, [
          {
            type: "item.upsert",
            agent: "root",
            item: `answer-${turn}`,
            draft: {
              type: "message",
              role: "assistant",
              complete: true,
              parts: [{ type: "text", text: `Answer ${turn}. ` + "A line of prose. ".repeat(400) }],
            },
          },
          { type: "turn.ended", agent: "root", nativeTurnId, outcome: "completed" },
        ]);
      }
      // Frames held back: what lands meanwhile is ahead of every once-a-frame read.
      let held: FrameRequestCallback[] | undefined;
      const native = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        if (!held) return native(callback);
        held.push(callback);
        return 0;
      };
      window.heldFrames = {
        hold: () => {
          held = [];
        },
        release: () => {
          const queued = held ?? [];
          held = undefined;
          for (const callback of queued) native(callback);
        },
      };
    },
  });
}

test("scrolling up from the live end keeps the reader's row while older history lands", async ({
  page,
}) => {
  await page.addInitScript(seed);
  await page.goto("/t/older-history-place", { waitUntil: "domcontentloaded" });
  const feed = page.locator("[data-thread-column]").getByRole("feed", { name: "Transcript" });
  await expect(feed.getByText("Answer 23.")).toBeVisible({ timeout: 60_000 });
  const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
  await viewport.hover();
  const tall = await viewport.evaluate((el) => el.scrollHeight);

  const fromEnd = () => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(await fromEnd()).toBeLessThan(2);

  await page.evaluate(() => window.heldFrames.hold());
  await page.mouse.wheel(0, -300);
  // Older history lands above the reader before any frame reads where they are.
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight)).toBeGreaterThan(tall * 2);
  await page.evaluate(() => window.heldFrames.release());
  await page.waitForTimeout(300);
  // Nothing arrived below: the reader is still the 300px they scrolled up from the end.
  expect(Math.abs((await fromEnd()) - 300)).toBeLessThan(80);
});
