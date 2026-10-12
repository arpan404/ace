import { expect, type Page } from "@playwright/test";
import { facts, type FakeDaemon } from "@ace/fake-daemon";

const count = 600;
/** An asymmetric patch large enough to virtualize, with long prose on only the new side. */
export async function installSplitAlignmentFixture(page: Page) {
  const old = Array.from({ length: count }, (_, i) => `-// previous row ${i + 1}`);
  const next = Array.from(
    { length: count },
    (_, i) =>
      `+// revised row ${i + 1}${i % 7 === 0 ? ` ${"Keep the reconnect boundary visible while reviewing the changed request. ".repeat(7)}` : ""}`,
  );
  const patch = [
    "diff --git a/alignment.ts b/alignment.ts",
    "--- a/alignment.ts",
    "+++ b/alignment.ts",
    `@@ -1,${count} +1,${count} @@`,
    ...old,
    ...next,
    "",
  ].join("\n");
  const events = [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.tool("root", "edit", {
      kind: "file.edit",
      title: "Update alignment.ts",
      detail: {
        kind: "file.edit",
        changes: [{ path: "alignment.ts", kind: "update", diff: patch }],
      },
    }),
    facts.toolDone("root", "edit"),
    facts.endTurn("root"),
  ];
  await page.addInitScript(
    (updates) =>
      Object.assign(globalThis, {
        aceFakeSetup: (daemon: FakeDaemon) => {
          daemon.createThread({
            id: "split-alignment",
            workspaceId: "relay",
            title: "Review split alignment",
            provider: "codex",
          });
          daemon.apply("split-alignment", updates);
        },
      }),
    events,
  );
}

/** Compare the actual top and height of every mounted pair, including virtual spacer offsets. */
export async function expectSplitRowsAligned(page: Page) {
  await expect
    .poll(() =>
      page.locator('[data-diff-side="old"]').evaluate((before) => {
        const after = before.parentElement?.querySelector('[data-diff-side="new"]');
        if (!after) return false;
        const pairs = new Map(
          [...after.querySelectorAll<HTMLElement>("[data-diff-pair]")].map((node) => [
            node.dataset.diffPair,
            node.getBoundingClientRect(),
          ]),
        );
        const old = [...before.querySelectorAll<HTMLElement>("[data-diff-pair]")];
        return (
          old.length > 2 &&
          old.every((node) => {
            const right = pairs.get(node.dataset.diffPair);
            const left = node.getBoundingClientRect();
            return (
              !!right &&
              Math.abs(left.top - right.top) < 1 &&
              Math.abs(left.height - right.height) < 1
            );
          })
        );
      }),
    )
    .toBe(true);
}

export async function openSplitAlignment(page: Page, base: string) {
  await page.goto(`${base}/t/split-alignment`);
  await page.getByRole("heading", { level: 1, name: "Review split alignment" }).waitFor();
  await page.getByRole("button", { name: "Right panel", exact: true }).click();
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: "Full view", exact: true }).click();
  await page.getByRole("button", { name: "Diff options", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Split", exact: true }).click();
  await page.getByRole("button", { name: "Diff options", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Soft wrap at word boundaries", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.locator('[data-diff-side="new"] [data-diff-pair]').count())
    .toBeGreaterThan(2);
  expect(await page.locator('[data-diff-side="new"] [data-diff-pair]').count()).toBeLessThan(count);
  await expect
    .poll(() =>
      page
        .locator('[data-diff-side="new"] [data-diff-pair]')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height),
    )
    .toBeGreaterThan(20);
  await expectSplitRowsAligned(page);
}

export async function expandSplitComment(page: Page) {
  const after = page.locator('[data-diff-side="new"]');
  await after.getByRole("button", { name: "Comment on line 1", exact: true }).click();
  await expectSplitRowsAligned(page);
  await page.getByRole("button", { name: "Suggest change", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Suggested change", exact: true })
    .fill(
      "// A multiline suggestion\n// Another line\n// And one more line\n// Keep both panes aligned",
    );
  await expectSplitRowsAligned(page);
  await page
    .getByRole("textbox", { name: "Comment on line 1", exact: true })
    .fill("Check the reconnect boundary before publishing this change. ".repeat(12));
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(
    after.getByRole("article", { name: "Comment on line 1", exact: true }),
  ).toBeVisible();
  await expectSplitRowsAligned(page);
}

export async function scrollSplitAwayAndBack(page: Page) {
  const scroller = page.locator("[data-diff-scroller]");
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight * 0.7;
  });
  await expect
    .poll(() =>
      page
        .locator('[data-diff-side="new"] [data-line]')
        .first()
        .getAttribute("data-line")
        .then(Number),
    )
    .toBeGreaterThan(200);
  await expectSplitRowsAligned(page);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.getByRole("article", { name: "Comment on line 1", exact: true })).toBeVisible();
  await expectSplitRowsAligned(page);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("article", { name: "Comment on line 1", exact: true })).toHaveCount(
    0,
  );
  await expectSplitRowsAligned(page);
}
