import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

function withRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  return app;
}
const listed = async () =>
  within(await screen.findByRole("navigation", { name: "Pull requests" }))
    .queryAllByRole("link")
    .flatMap((row) => /#(\d+)/.exec(row.textContent ?? "")?.[1] ?? []);

test("a pull request no thread is linked to merges from the page and leaves the open list", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&pr=224");
  const panel = await screen.findByRole("article", { name: "Pull request #224" });
  const merge = await within(panel).findByRole("button", { name: "Squash and merge" });
  await userEvent.click(merge);
  await userEvent.click(await within(panel).findByRole("button", { name: "Confirm merge?" }));
  expect(await within(panel).findByRole("button", { name: "Merged: Merged" })).toBeTruthy();
  await waitFor(async () => expect(await listed()).not.toContain("224"));
});

test("a pull request that conflicts with its base offers to resolve the conflicts, not to merge", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&pr=226");
  const panel = await screen.findByRole("article", { name: "Pull request #226" });
  expect(await within(panel).findByRole("button", { name: "Resolve conflicts" })).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: /merge$/i })).toBeNull();
});

test("a pull request with failing checks and requested changes can't merge and says why", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace&pr=229");
  const panel = await screen.findByRole("article", { name: "Pull request #229" });
  const blocked = await within(panel).findByRole("button", { name: "Merge blocked" });
  expect((blocked as HTMLButtonElement).disabled).toBe(true);
  expect(within(panel).getByText(/1 failing/)).toBeTruthy();
  expect(within(panel).getByText("Changes requested")).toBeTruthy();
});
