import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`pair stays on the pairing view and sidebar rows do not overlap at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/pair");
    await expect(page.getByRole("heading", { name: "Pair a device", level: 2 })).toBeVisible();
    await expect(page.getByRole("feed", { name: "Transcript" })).toHaveCount(0);
    if (width === 390) {
      await page.getByRole("button", { name: "Back to threads" }).click();
    }
    const links = page.getByRole("navigation", { name: "Threads" }).getByRole("link");
    await expect(links.first()).toBeVisible();
    await expect
      .poll(async () => {
        const boxes = await links.evaluateAll((rows) =>
          rows
            .map((row) => {
              const box = row.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            })
            .filter((box) => box.top < 820 && box.bottom > 86),
        );
        return boxes.slice(1).every((current, index) => {
          const previous = boxes[index];
          return previous && current.top >= previous.bottom && current.top - previous.bottom <= 16;
        });
      })
      .toBe(true);
    // Known provider glyphs must have ink, rather than just the account initial.
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Claude Code", exact: true })
          .first()
          .locator("svg")
          .evaluateAll((marks) => marks.some((mark) => mark.querySelector("path"))),
      )
      .toBe(true);
  });

  test(`settings labels, hints and controls align and work by keyboard at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/general");
    const worktree = page.getByRole("switch", { name: "New threads use a worktree" });
    await expect(worktree).toBeVisible();
    const merged = page.getByRole("switch", { name: "Settle when the PR merges" });
    const closed = page.getByRole("switch", { name: "Settle when the PR closes" });
    const rightEdges = await Promise.all(
      [worktree, merged, closed].map(async (control) => {
        const box = await control.boundingBox();
        if (!box) throw new Error("Missing control");
        return box.x + box.width;
      }),
    );
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1);
    await expect(page.getByText("Keeps your checkout clean.", { exact: true })).toBeVisible();
    await worktree.focus();
    await page.keyboard.press("Space");
    await expect(worktree).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Settle done threads" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Never", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: "Settle done threads" })).toBeFocused();
  });

  test(`inline approval stays above the message field at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/thread-checkout");
    const approval = page.getByRole("region", { name: "Waiting for you" });
    const deny = approval.getByRole("button", { name: "Deny", exact: true });
    await expect(deny).toBeVisible();
    const message = page.getByRole("combobox", { name: "Message" });
    const a = await approval.boundingBox(),
      m = await message.boundingBox();
    if (!a || !m) throw new Error("Missing request or message field");
    expect(a.y + a.height).toBeLessThanOrEqual(m.y);
    await expect(
      page
        .getByRole("feed", { name: "Transcript" })
        .getByText("Waiting for your approval", { exact: true }),
    ).toHaveCount(0);
    await deny.focus();
    await page.keyboard.press("Enter");
    await expect(approval).toHaveCount(0);
  });
}

test("thread hover details stay in the sidebar gutter", async ({ page }) => {
  await page.goto("/archived");
  const threads = page.getByRole("navigation", { name: "Threads" });
  const row = threads.getByRole("link").first();
  await expect(row).toBeVisible();
  await row.hover();
  const details = page.getByLabel(/^Details for /);
  await expect(details).toBeVisible();
  const r = await row.boundingBox(),
    d = await details.boundingBox();
  if (!r || !d) throw new Error("Missing hover detail");
  expect(d.x + d.width).toBeLessThanOrEqual(r.x + r.width + 8);
});

test("compact setting hints and row actions are available from the keyboard", async ({ page }) => {
  await page.goto("/settings/remote");
  const remote = page.getByRole("switch", { name: "Remote access" });
  await expect(remote).toBeVisible();
  await remote.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip")).toContainText("This machine");
  const actions = page.getByRole("button", { name: "Actions for This Mac" });
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
});
