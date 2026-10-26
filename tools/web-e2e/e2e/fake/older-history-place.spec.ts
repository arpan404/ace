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

/**
 * Busy turns: `turns` asks, each with `steps` tool steps and an answer of `prose` sentences;
 * the last `recent` turns answer in `recentProse`.
 */
function seed(shape?: {
  turns: number;
  steps: number;
  prose: number;
  recent?: number;
  recentProse?: number;
}) {
  const {
    turns,
    steps,
    prose,
    recent = 0,
    recentProse = prose,
  } = shape ?? {
    turns: 24,
    steps: 20,
    prose: 400,
  };
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
      for (let turn = 0; turn < turns; turn++) {
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
        for (let step = 0; step < steps; step++) {
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
              parts: [
                {
                  type: "text",
                  text:
                    `Answer ${turn}. ` +
                    "A line of prose. ".repeat(turn >= turns - recent ? recentProse : prose),
                },
              ],
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

test("text selected in a message stays selected while older history lands above it", async ({
  page,
}) => {
  // Short turns: a page of older history is many rows, landing far above the reader's row.
  await page.addInitScript(seed, { turns: 160, steps: 1, prose: 30 });
  await page.goto("/t/older-history-place", { waitUntil: "domcontentloaded" });
  const feed = page.locator("[data-thread-column]").getByRole("feed", { name: "Transcript" });
  await expect(feed.getByText("Answer 159.")).toBeVisible({ timeout: 60_000 });
  const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
  await viewport.hover();
  const tall = await viewport.evaluate((el) => el.scrollHeight);

  // The reader selects an answer in view, then scrolls up a little; again, until a page of
  // older history lands while the selection is on screen.
  let selected = "";
  let landed = false;
  for (let step = 0; step < 40 && !landed; step++) {
    selected = await viewport.evaluate((view) => {
      const bounds = view.getBoundingClientRect();
      const answer = [...view.querySelectorAll("p")].find((p) => {
        const box = p.getBoundingClientRect();
        return (
          p.textContent?.startsWith("Answer ") &&
          box.top > bounds.top + 40 &&
          box.bottom < bounds.bottom - 40
        );
      });
      const selection = getSelection();
      selection?.removeAllRanges();
      if (!answer) return "";
      const range = document.createRange();
      range.selectNodeContents(answer);
      selection?.addRange(range);
      return selection?.toString() ?? "";
    });
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
    landed = (await viewport.evaluate((el) => el.scrollHeight)) > tall * 1.5;
  }
  expect(landed).toBe(true);
  expect(selected).toMatch(/^Answer \d+\./);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
});

test("older history taller than its estimate lands above the reader without moving them", async ({
  page,
}) => {
  // What is loaded is a little over a screen; older answers are far taller than a row's first
  // estimate.
  await page.addInitScript(seed, {
    turns: 12,
    steps: 60,
    prose: 600,
    recent: 1,
    recentProse: 200,
  });
  await page.goto("/t/older-history-place", { waitUntil: "domcontentloaded" });
  const feed = page.locator("[data-thread-column]").getByRole("feed", { name: "Transcript" });
  await expect(feed.getByText("Answer 11.")).toBeVisible({ timeout: 60_000 });
  const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
  const tall = await viewport.evaluate((el) => el.scrollHeight);

  // The reader is at the top of what is loaded, and has stopped scrolling.
  await viewport.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  const answer = feed.getByText(/^Answer \d+\./).first();
  const read = await answer.textContent();
  const reading = feed.getByText(read ?? "", { exact: true });
  await expect(reading).toBeInViewport();
  const top = async () => (await reading.boundingBox())?.y ?? Number.NaN;
  const before = await top();

  // One nudge up asks for the page above; it lands while nothing scrolls.
  await viewport.hover();
  await page.mouse.wheel(0, -40);
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight)).toBeGreaterThan(tall * 1.5);
  await page.waitForTimeout(400);
  await expect(reading).toBeInViewport();
  expect(Math.abs((await top()) - before)).toBeLessThan(60);
});
