import { expect, test, type Page } from "@playwright/test";

/** The Files and Browser tools of the side panel, against the fake daemon's checkouts and page. */

const sidePanel = (page: Page) => page.getByRole("region", { name: "Thread panel" });

async function open(page: Page) {
  await page.goto("/t/thread-cold-start");
  await expect(
    page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeVisible();
}

test("⌘P opens a checkout file; a click in its tree previews another in the same place", async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("combobox", { name: "Search files" }).fill("replay.ts");
  await expect(page.getByRole("option", { name: /replay\.ts/ })).toBeVisible();
  await page.keyboard.press("Enter");

  const panel = sidePanel(page);
  await expect(panel.getByRole("tab", { name: "replay.ts", selected: true })).toBeVisible();
  const source = panel.getByRole("region", { name: "Source of apps/server/src/replay.ts" });
  await expect(source).toContainText("const COLD_START_WINDOW = 200;");

  // The kept tab stays; outbox.ts opens beside it as a preview, then socket.ts takes its place.
  // A side panel this narrow opens the tree over the file and closes it after a pick.
  await panel.getByRole("button", { name: "Show the file tree" }).click();
  await panel.getByRole("treeitem", { name: "outbox.ts" }).click();
  await expect(panel.getByRole("tab", { name: "outbox.ts", selected: true })).toBeVisible();
  await expect(panel.getByRole("complementary", { name: "Checkout files" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Show the file tree" }).click();
  const filter = panel.getByRole("searchbox", { name: "Find files in the checkout" });
  await filter.fill("socket");
  await panel
    .getByRole("tree", { name: "Matching files" })
    .getByRole("treeitem", { name: "socket.ts" })
    .click();
  await expect(panel.getByRole("tab", { name: "socket.ts", selected: true })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "replay.ts" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "outbox.ts" })).toHaveCount(0);
});

test("an address from the new tab opens the Browser, Back returns, and a dead port says why", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Right panel" }).click();
  const panel = sidePanel(page);
  await panel.getByRole("button", { name: "New tab" }).click();
  const address = panel.getByRole("combobox", { name: "Address" });
  await address.fill("docs.example.com/guide");
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "docs.example.com", selected: true })).toBeVisible();
  await expect(
    panel.getByRole("img", { name: "Live view of https://docs.example.com/guide" }),
  ).toBeVisible();
  await expect(panel.getByText("have control", { exact: false })).toBeVisible();

  await address.fill("localhost:4321");
  await address.press("Enter");
  const failure = panel.getByRole("alert");
  await expect(failure).toContainText("This site can't be reached");
  await expect(failure).toContainText("ERR_CONNECTION_REFUSED");
  await expect(address).toHaveValue("localhost:4321");

  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(address).toHaveValue("docs.example.com/guide");
  await panel.getByRole("button", { name: "Hand back" }).click();
  await expect(panel.getByText("is using this page", { exact: false })).toBeVisible();
});
