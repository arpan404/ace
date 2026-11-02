import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const rows = () =>
  [...threads().querySelectorAll<HTMLElement>("[data-row-focus]")].map(
    (row) => row.getAttribute("aria-label")?.split(". ")[0] ?? "",
  );
/** The panel's title, which steps aside (hidden with its row) while the search is open. */
const heading = () => screen.getByText("Threads", { selector: "h2" });
const titleHidden = () => heading().closest("[aria-hidden=true]") !== null;

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await screen.findByRole("navigation", { name: "Threads" });
  await waitFor(() => expect(rows().length).toBeGreaterThan(1));
}

test("the title's search opens in place, narrows the Inbox forgiving a typo, and × puts it back", async () => {
  await openHome();
  const all = rows();
  await userEvent.click(screen.getByRole("button", { name: "Search threads" }));
  // The title steps aside for the field, which takes the typing at once.
  const field = screen.getByRole("searchbox", { name: "Search threads" });
  expect(document.activeElement).toBe(field);
  expect(titleHidden()).toBe(true);

  await userEvent.type(field, "retyr budget");
  await waitFor(() => expect(rows()).toEqual(["Retry budget for app-server restarts"]));

  await userEvent.click(screen.getByRole("button", { name: "Close search" }));
  await waitFor(() => expect(rows()).toEqual(all));
  // Closed, the field leaves the page's reading order and the title returns.
  expect(screen.queryByRole("searchbox", { name: "Search threads" })).toBeNull();
  expect(titleHidden()).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search threads" }));
});

test("Esc clears the search first, then closes it; nothing matching says so", async () => {
  await openHome();
  await userEvent.click(screen.getByRole("button", { name: "Search threads" }));
  const field = screen.getByRole("searchbox", { name: "Search threads" });
  await userEvent.type(field, "zzzz qqqq");
  expect(await within(threads()).findByText("No threads match.")).toBeTruthy();

  await userEvent.keyboard("{Escape}");
  expect(field).toHaveProperty("value", "");
  await waitFor(() => expect(rows().length).toBeGreaterThan(1));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(titleHidden()).toBe(false));
});
