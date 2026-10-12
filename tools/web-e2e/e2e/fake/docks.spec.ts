import { expect, test, type Page } from "@playwright/test";

/** The side panel: resource tabs beside a thread, kept per thread. */

const sidePanel = (page: Page) => page.getByRole("region", { name: "Thread panel" });
const tabs = (page: Page) =>
  sidePanel(page).getByRole("tablist", { name: "Thread panel tabs" }).getByRole("tab");

async function open(page: Page, path: string, title: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function launch(page: Page, tool: string) {
  await sidePanel(page).getByRole("button", { name: "New tab" }).click();
  await sidePanel(page)
    .getByRole("list", { name: "Tools" })
    .getByRole("button", { name: new RegExp(`^${tool}`) })
    .click();
}

/** The Preview tab, titled by the dev server it shows once one does. */
const preview = /^(Preview|web · :\d+)/;

test("the + launcher becomes the tool picked from it, and tabs reorder and close one at a time", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(tabs(page)).toHaveText(["Work", /^Changes/, "Files"]);

  await launch(page, "Preview");
  await expect(tabs(page)).toHaveText(["Work", /^Changes/, "Files", preview]);
  await expect(sidePanel(page).getByRole("tab", { name: preview, selected: true })).toBeVisible();
  await launch(page, "Devices");
  await expect(tabs(page)).toHaveText(["Work", /^Changes/, "Files", preview, "Devices"]);

  // Drag Devices before Preview; the showing tab stays Devices.
  await sidePanel(page)
    .getByRole("tab", { name: "Devices" })
    .dragTo(sidePanel(page).getByRole("tab", { name: preview }), {
      targetPosition: { x: 4, y: 8 },
    });
  await expect(tabs(page)).toHaveText(["Work", /^Changes/, "Files", "Devices", preview]);
  await expect(sidePanel(page).getByRole("tab", { name: "Devices", selected: true })).toBeVisible();

  // Closing the showing tab shows its neighbour; the others stay.
  await sidePanel(page).getByRole("button", { name: "Close Devices" }).click();
  await expect(tabs(page)).toHaveText(["Work", /^Changes/, "Files", preview]);
  await expect(sidePanel(page).getByRole("tab", { name: preview, selected: true })).toBeVisible();
});

test("each thread keeps its own tabs, showing tab and panel, and gets them back on return", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await launch(page, "Preview");

  await open(page, "/t/thread-install-page", /./);
  await expect(sidePanel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(tabs(page)).toHaveText(["Work", /^Changes/, "Files"]);

  await page.goBack();
  await expect(
    page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeVisible();
  await expect(sidePanel(page).getByRole("tab", { name: preview, selected: true })).toBeVisible();
});

test("full view gives the side panel the work area and Back to the conversation restores the split", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await expect(
    sidePanel(page).getByRole("tab", { name: /^Changes/, selected: true }),
  ).toBeVisible();
  const split = (await sidePanel(page).boundingBox())?.width ?? 0;

  await sidePanel(page).getByRole("button", { name: "Full view" }).click();
  await expect(page.getByRole("feed", { name: "Transcript" })).toBeHidden();
  expect((await sidePanel(page).boundingBox())?.width ?? 0).toBeGreaterThan(split);

  await sidePanel(page)
    .getByRole("button", { name: /Cap cold-start replay/ })
    .click();
  await expect(page.getByRole("feed", { name: "Transcript" })).toBeVisible();
  expect(Math.round((await sidePanel(page).boundingBox())?.width ?? 0)).toBe(Math.round(split));
});

test("⌘J shows the thread's terminal in the side panel, Ctrl+` hides it from inside the shell, and the shell survives", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(sidePanel(page).getByRole("tab", { name: "zsh", selected: true })).toBeVisible();
  const terminal = sidePanel(page).getByRole("group", { name: "zsh terminal" });
  await terminal.click();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("/Users/dev/ace");

  // The same toggle, pressed while the terminal shows (and has the keyboard), hides the panel.
  await page.keyboard.press("Control+Backquote");
  await expect(sidePanel(page)).toHaveCount(0);
  // ⌘J again brings back the same shell, with what it printed.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(sidePanel(page).getByRole("tab", { name: "zsh", selected: true })).toBeVisible();
  await expect(terminal).toContainText("/Users/dev/ace");
  await expect(sidePanel(page).getByRole("tab", { name: "zsh" })).toHaveCount(1);
});

test("with five tabs in the side panel, the showing tab stays whole inside the strip", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await launch(page, "Preview");
  // With the pinned Changes, Agents and Files.
  await launch(page, "Devices");
  await expect(tabs(page)).toHaveCount(5);
  const strip = sidePanel(page).getByRole("tablist", { name: "Thread panel tabs" });
  const inside = async (name: string | RegExp) => {
    const tab = strip.getByRole("tab", { name, selected: true });
    await expect(tab).toBeVisible();
    await expect
      .poll(async () => {
        const [box, list] = await Promise.all([tab.boundingBox(), strip.boundingBox()]);
        if (!box || !list) return false;
        return box.x >= list.x - 0.5 && box.x + box.width <= list.x + list.width + 0.5;
      })
      .toBe(true);
    // Its whole title shows: nothing is cut off with an ellipsis.
    expect(
      await tab.evaluate((element) => {
        const title = element.querySelector<HTMLElement>("[data-tab-title]");
        return title ? title.scrollWidth <= title.clientWidth : false;
      }),
    ).toBe(true);
  };
  await inside("Devices");
  // The first tab, folded or not, comes back whole when shown.
  await strip.getByRole("tab").first().click();
  await inside("Work");
  await strip.getByRole("tab").last().click();
  await inside("Devices");
});

test("the header keeps a readable title and a single menu beside the Work panel", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  const header = page.getByRole("banner");
  await expect(header.getByRole("button", { name: /^Work card/ })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "More actions" })).toHaveCount(1);
  const title = page.getByRole("heading", { level: 1 });
  const room = await title.evaluate((element) => ({
    shown: element.clientWidth,
    whole: element.scrollWidth,
  }));
  expect(room.shown).toBeGreaterThanOrEqual(Math.min(160, room.whole));
  await expect(sidePanel(page).getByRole("tab", { name: "Work", selected: true })).toBeVisible();
});

test("at the default 520px panel, address suggestions show their detail beside the address", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await sidePanel(page).getByRole("button", { name: "New tab" }).click();
  await sidePanel(page)
    .getByRole("list", { name: "Tools", exact: true })
    .getByRole("button", { name: /^Browser(?: |$)/ })
    .click();
  await sidePanel(page)
    .getByRole("combobox", { name: /Address/ })
    .click();
  await page.keyboard.type("local");
  const suggestion = sidePanel(page)
    .getByRole("listbox", { name: "Suggested addresses" })
    .getByRole("option")
    .first();
  await expect(suggestion).toContainText("localhost:5173");
  // The detail truncates if it must, but shows.
  await expect(suggestion.getByText(/thread's browser|Dev server/)).toBeVisible();
});
