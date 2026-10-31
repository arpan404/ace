import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const rowTitles = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => link.getAttribute("aria-label")?.split(". ")[0]);
const search = () => screen.getByRole("searchbox", { name: "Search all threads" });

/** The workbench with its Codex bump (project ace) and PDF locale fix (billing-api) settled. */
async function openWorkbench() {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.organizer", JSON.stringify({ baseline: 0, project: null }));
  const app = harness({ storage });
  await app.client.start();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  for (const id of ["thread-bump-codex", "thread-pdf-locale"])
    await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
  await app.open("/new");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

test("typing in the panel's search lists matching threads, then settled matches under their heading", async () => {
  await openWorkbench();
  expect(rowTitles()).not.toContain("Bump Codex app-server to 0.48");
  await userEvent.type(search(), "codex");
  await waitFor(() =>
    expect(within(threads()).getByRole("heading", { name: /^Settled · 1/ })).toBeTruthy(),
  );
  expect(rowTitles()).toEqual(["Bump Codex app-server to 0.48"]);
  // Escape clears the search and the whole list comes back.
  await userEvent.keyboard("{Escape}");
  expect((search() as HTMLInputElement).value).toBe("");
  await waitFor(() => expect(rowTitles()).toContain("Partial refunds double-count tax"));
  expect(within(threads()).queryByRole("heading", { name: /^Settled/ })).toBeNull();
});

test("search matches a thread's project and branch, not only its title", async () => {
  await openWorkbench();
  await userEvent.type(search(), "fix/refund-tax");
  await waitFor(() => expect(rowTitles()).toEqual(["Partial refunds double-count tax"]));
  await userEvent.clear(search());
  await userEvent.type(search(), "relay");
  await waitFor(() =>
    expect(rowTitles()).toEqual([
      "Retry budget for app-server restarts",
      "Backpressure on broadcast fan-out",
    ]),
  );
});

test("a search with no match says so", async () => {
  await openWorkbench();
  await userEvent.type(search(), "zebra crossing");
  expect(await screen.findByText("Nothing matches “zebra crossing”.")).toBeTruthy();
  expect(rowTitles()).toEqual([]);
});

test("a project's N settled opens only that project's settled threads, in place", async () => {
  await openWorkbench();
  expect(rowTitles()).not.toContain("Invoice PDF locale fallback");
  const billing = within(threads()).getByRole("button", { name: "1 settled in billing-api" });
  await userEvent.click(billing);
  expect(billing.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(rowTitles()).toContain("Invoice PDF locale fallback"));
  expect(rowTitles()).not.toContain("Bump Codex app-server to 0.48");
  await userEvent.click(within(threads()).getByRole("button", { name: "1 settled in billing-api" }));
  await waitFor(() => expect(rowTitles()).not.toContain("Invoice PDF locale fallback"));
});
