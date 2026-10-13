import { expect, test, type Page } from "@playwright/test";

/*
 * Instant send (UX audit W2): Enter on New thread never blanks the main pane. A per-frame probe
 * samples every animation frame from Enter until the new thread's first turn ends, and checks
 * the composer is on screen in each one, in the same place and width as on New thread, that the
 * message shows within 50 ms, and that nothing shifts (CLS ≤ 0.01).
 */

interface Frame {
  /** Milliseconds since the Enter keydown. */
  t: number;
  path: string;
  composer: { x: number; width: number } | null;
  message: boolean;
}

/** Start sampling every frame; the Enter keydown's own time is the probe's zero. */
async function startProbe(page: Page, text: string) {
  await page.evaluate((needle) => {
    const probe = { frames: [] as Frame[], cls: 0, enter: undefined as number | undefined };
    Object.assign(window, { aceSendProbe: probe });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (probe.enter !== undefined && !entry.hadRecentInput) probe.cls += entry.value;
    }).observe({ type: "layout-shift" });
    addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") probe.enter = event.timeStamp;
      },
      { capture: true },
    );
    const sample = (now: number) => {
      if (probe.enter !== undefined) {
        const box = document.querySelector('[data-slot="composer"]')?.getBoundingClientRect();
        const feed = document.querySelector('[role="feed"]');
        probe.frames.push({
          t: now - probe.enter,
          path: location.pathname,
          composer: box ? { x: box.x, width: box.width } : null,
          message: !!feed?.textContent?.includes(needle),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, text);
}

const readProbe = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { aceSendProbe: { frames: Frame[]; cls: number } }).aceSendProbe,
  );

for (const mode of ["worktree", "local"] as const) {
  test(`sending from New thread (${mode}) keeps the composer on every frame and shows the message at once`, async ({
    page,
  }) => {
    await page.goto("/new");
    const message = page.getByRole("combobox", { name: "Message" });
    await expect(message).toBeVisible();
    const worktree = page.getByRole("checkbox", { name: "Worktree" });
    await expect(worktree).toBeVisible();
    if ((await worktree.isChecked()) !== (mode === "worktree")) await worktree.click();
    const text = `Zebra ${mode} instant send`;
    await message.click();
    await message.pressSequentially(text);
    const before = await page.locator('[data-slot="composer"]').boundingBox();
    await startProbe(page, text);
    await page.keyboard.press("Enter");

    // Until the first turn ends in the real thread.
    await page.waitForURL(/\/t\/thread-/);
    await expect(page.getByText(/^Worked for/)).toBeVisible({ timeout: 15_000 });
    const after = await page.locator('[data-slot="composer"]').boundingBox();
    const { frames, cls } = await readProbe(page);

    expect(frames.length).toBeGreaterThan(10);
    expect(frames.filter((frame) => !frame.composer)).toEqual([]);
    const shown = frames.find((frame) => frame.message);
    expect(shown?.t).toBeLessThanOrEqual(50);
    // Once shown, the message never leaves the screen.
    expect(frames.filter((frame) => shown && frame.t > shown.t && !frame.message)).toEqual([]);
    for (const frame of frames) {
      expect(frame.composer?.x).toBeCloseTo(before?.x ?? -1, 0);
      expect(frame.composer?.width).toBeCloseTo(before?.width ?? -1, 0);
    }
    expect(after?.x).toBeCloseTo(before?.x ?? -1, 0);
    expect(after?.width).toBeCloseTo(before?.width ?? -1, 0);
    expect(cls).toBeLessThanOrEqual(0.01);
  });
}
